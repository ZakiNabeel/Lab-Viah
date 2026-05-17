import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import { env } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { AppError } from '../../utils/errors.js';
import { recover, type TraceBus } from './trace.js';

// =========================================================
// Gemini wrapper — Vertex AI via @google/genai (the official SDK).
// Every agent calls Gemini ONLY through this module. We centralize:
//   - retry policy (2 attempts on the primary model)
//   - Pro -> Flash fallback (on rate-limit, timeout, or repeated failure)
//   - trace emissions for tool.call + tool.result
// See ANTIGRAVITY.md §3 and MASTERPLAN.md §9.
//
// Why Vertex (not AI Studio): the AI Studio free tier clamps Gemini 3 Pro to
// quota=0, so every Pro call 429s and falls back to Flash. Vertex bills via
// GCP and the free $300/$5 credits apply. Public API of `geminiCall` is
// UNCHANGED — callers don't know which backend is live.
//
// Why @google/genai (not @google-cloud/vertexai): the latter was deprecated
// 2025-06-24 and is being removed 2026-06-24 (~5 weeks after this hackathon).
// @google/genai is Google's unified, supported successor — same Vertex auth
// (ADC reads GOOGLE_APPLICATION_CREDENTIALS), cleaner API.
// =========================================================

const client = new GoogleGenAI({
  vertexai: true,
  project: env.GCP_PROJECT_ID,
  location: env.GCP_LOCATION,
});

export type GeminiCallInput = {
  prompt: string;
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  // When true, fall back to Flash model after primary failure. Defaults to true.
  allowFallback?: boolean;
  // JSON-mode: instruct the model to return JSON via responseMimeType.
  responseFormat?: 'text' | 'json';
  // Which tier to use as the primary model. Default 'pro' (VERTEX_MODEL_PRIMARY).
  // 'flash' skips Pro entirely — pin Twin turns and other low-stakes calls
  // here per MASTERPLAN §8.2 ("downgrade to Flash for non-Moderator agents")
  // to avoid Pro's thinking-token overhead and parallel-rate-limit pressure.
  modelTier?: 'pro' | 'flash';
};

export type GeminiCallResult = {
  text: string;
  modelUsed: string;
  latencyMs: number;
  fallbackUsed: boolean;
};

const PRIMARY_ATTEMPTS = 2;
// 12s — Flash with thinking off responds in 1-3s when Vertex isn't under
// pressure. 30s was patient enough to chain 3 timeouts × 3 attempts into
// 90+s per debate, eating the per-debate budget. Under hackathon-tier quota
// the right move is fail-fast: a single 12s wall, the deterministic fallback
// kicks in, and the next debate's call still gets a slot in time. Pro calls
// (rare in this path) can live with the same wall — they take 10-15s when
// they work and we'd rather skip them than wait 30s.
const PRIMARY_TIMEOUT_MS = 12_000;

// =========================================================
// Global concurrency cap — keeps Vertex from 429-throttling us under the
// 5-parallel-debates × 3-calls-per-dim burst load. Empirically:
//   - cap=8 → cascading 429s on us-central1 (the burst limit, not RPM).
//   - cap=3 → steady throughput, ~0 429s. The hackathon-tier per-region
//     burst limit on lab-viah seems to land here. Bump if quota grows.
// =========================================================
const MAX_CONCURRENT = 3;
let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight += 1;
}

function release(): void {
  inFlight -= 1;
  const next = waiters.shift();
  if (next) next();
}

function isRateLimit(err: unknown): boolean {
  const s = err instanceof Error ? err.message : String(err);
  return /RESOURCE_EXHAUSTED|429|rate.?limit/i.test(s);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function geminiCall(
  input: GeminiCallInput,
  bus?: TraceBus
): Promise<GeminiCallResult> {
  const allowFallback = input.allowFallback ?? true;
  const tier = input.modelTier ?? 'pro';
  // 'flash' callers go straight to the fallback model — no Pro attempt — so
  // they don't pay the Pro thinking-budget tax for low-stakes turns.
  const primaryModel = tier === 'flash' ? env.VERTEX_MODEL_FALLBACK : env.VERTEX_MODEL_PRIMARY;
  const fallbackModel = env.VERTEX_MODEL_FALLBACK;
  const start = Date.now();

  bus?.emit({
    type: 'tool.call',
    tool: 'geminiCall',
    args: {
      model: primaryModel,
      tier,
      location: env.GCP_LOCATION,
      promptChars: input.prompt.length,
      temperature: input.temperature,
    },
    ts: Date.now(),
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= PRIMARY_ATTEMPTS; attempt++) {
    try {
      const result = await callModel(primaryModel, input);
      const latency = Date.now() - start;
      bus?.emit({
        type: 'tool.result',
        tool: 'geminiCall',
        result: { modelUsed: result.modelUsed, chars: result.text.length, attempts: attempt },
        latency_ms: latency,
        ts: Date.now(),
      });
      return { ...result, latencyMs: latency, fallbackUsed: false };
    } catch (err) {
      lastError = err;
      logger.warn(
        { attempt, model: primaryModel, err: serialize(err) },
        'gemini primary attempt failed'
      );
      if (attempt < PRIMARY_ATTEMPTS) {
        // Exponential backoff with jitter. 429s cluster — without a delay
        // attempt 2 fires inside the same burst window and gets 429'd
        // identically. 600ms × 2^(attempt-1) + ~200ms jitter pushes us past
        // Vertex's per-second burst window.
        const base = isRateLimit(err) ? 1200 : 600;
        const backoff = base * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
        await sleep(backoff);
      }
    }
  }

  // If primary IS fallback (tier=flash) there's no further fallback model.
  if (!allowFallback || primaryModel === fallbackModel) {
    bus?.emit({
      type: 'tool.result',
      tool: 'geminiCall',
      result: { error: 'primary exhausted, no further fallback' },
      latency_ms: Date.now() - start,
      ts: Date.now(),
    });
    throw new AppError(
      'UPSTREAM_FAILURE',
      `Vertex Gemini (${primaryModel}) failed after ${PRIMARY_ATTEMPTS} attempts: ${serialize(lastError)}`,
      { cause: serialize(lastError) }
    );
  }

  if (bus) recover(bus, `vertex primary (${primaryModel}) exhausted`, `falling back to ${fallbackModel}`);

  try {
    const fb = await callModel(fallbackModel, input);
    const latency = Date.now() - start;
    bus?.emit({
      type: 'tool.result',
      tool: 'geminiCall',
      result: { modelUsed: fb.modelUsed, chars: fb.text.length, fallbackUsed: true },
      latency_ms: latency,
      ts: Date.now(),
    });
    return { ...fb, latencyMs: latency, fallbackUsed: true };
  } catch (err) {
    bus?.emit({
      type: 'tool.result',
      tool: 'geminiCall',
      result: { error: 'primary + fallback exhausted' },
      latency_ms: Date.now() - start,
      ts: Date.now(),
    });
    throw new AppError(
      'UPSTREAM_FAILURE',
      `Vertex Gemini primary (${primaryModel}) AND fallback (${fallbackModel}) both failed. Primary: ${serialize(lastError)} | Fallback: ${serialize(err)}`,
      { primary: serialize(lastError), fallback: serialize(err) }
    );
  }
}

async function callModel(
  modelName: string,
  input: GeminiCallInput
): Promise<{ text: string; modelUsed: string }> {
  await acquire();
  // Gemini 2.5 models have "thinking" enabled by default — they consume token
  // budget for invisible reasoning before producing the response. This
  // truncated our Twin-turn JSON mid-string (observed: "Unterminated string at
  // position 86") because thinking ate most of the 2048-token budget before
  // any output was emitted. Disable thinking on Flash where we already use
  // the SDK for compact, low-latency JSON. Pro keeps default thinking — its
  // thinking quality is the reason to use Pro at all.
  const isFlash = /flash/i.test(modelName);
  const callPromise = client.models.generateContent({
    model: modelName,
    contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
    config: {
      temperature: input.temperature ?? 0.4,
      maxOutputTokens: input.maxOutputTokens ?? 1024,
      ...(isFlash ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      ...(input.systemInstruction
        ? { systemInstruction: { role: 'system', parts: [{ text: input.systemInstruction }] } }
        : {}),
      ...(input.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
    },
  }).finally(release);

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new AppError('TIMEOUT', `Vertex Gemini ${modelName} exceeded ${PRIMARY_TIMEOUT_MS}ms`)),
      PRIMARY_TIMEOUT_MS
    )
  );

  const response: GenerateContentResponse = await Promise.race([callPromise, timeoutPromise]);

  // The SDK exposes `response.text` as a convenience getter that joins all
  // text parts of the first candidate. If a safety block or empty candidate
  // produced no text, surface a clean upstream error with the finish reason.
  const text = response.text?.trim();
  if (!text) {
    const finishReason = response.candidates?.[0]?.finishReason ?? 'no-candidate';
    throw new AppError(
      'UPSTREAM_FAILURE',
      `Vertex Gemini ${modelName} returned empty response (finishReason=${finishReason})`
    );
  }
  return { text, modelUsed: modelName };
}

function serialize(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// =========================================================
// Smoke test — used by /health/deep.
// =========================================================
export async function geminiSmokeTest(): Promise<{
  ok: boolean;
  modelUsed?: string;
  latencyMs?: number;
  error?: string;
}> {
  try {
    // maxOutputTokens needs headroom because 2.5+/3.x Gemini models consume
    // the token budget for internal "thinking" before producing visible
    // output. With a tiny cap (e.g. 8) the model thinks itself out before any
    // reply lands and returns an empty response. 256 is comfortably above all
    // observed thinking budgets while keeping the smoke test cheap.
    const result = await geminiCall({
      prompt: 'Reply with the single word: PONG',
      temperature: 0,
      maxOutputTokens: 256,
      allowFallback: true,
    });
    return { ok: true, modelUsed: result.modelUsed, latencyMs: result.latencyMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

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
};

export type GeminiCallResult = {
  text: string;
  modelUsed: string;
  latencyMs: number;
  fallbackUsed: boolean;
};

const PRIMARY_ATTEMPTS = 2;
const PRIMARY_TIMEOUT_MS = 15_000;

export async function geminiCall(
  input: GeminiCallInput,
  bus?: TraceBus
): Promise<GeminiCallResult> {
  const allowFallback = input.allowFallback ?? true;
  const start = Date.now();

  bus?.emit({
    type: 'tool.call',
    tool: 'geminiCall',
    args: {
      model: env.VERTEX_MODEL_PRIMARY,
      location: env.GCP_LOCATION,
      promptChars: input.prompt.length,
      temperature: input.temperature,
    },
    ts: Date.now(),
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= PRIMARY_ATTEMPTS; attempt++) {
    try {
      const result = await callModel(env.VERTEX_MODEL_PRIMARY, input);
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
        { attempt, model: env.VERTEX_MODEL_PRIMARY, err: serialize(err) },
        'gemini primary attempt failed'
      );
    }
  }

  if (!allowFallback) {
    bus?.emit({
      type: 'tool.result',
      tool: 'geminiCall',
      result: { error: 'primary exhausted, fallback disabled' },
      latency_ms: Date.now() - start,
      ts: Date.now(),
    });
    throw new AppError(
      'UPSTREAM_FAILURE',
      `Vertex Gemini primary (${env.VERTEX_MODEL_PRIMARY}) failed and fallback disabled: ${serialize(lastError)}`,
      { cause: serialize(lastError) }
    );
  }

  if (bus) recover(bus, 'vertex primary exhausted', `falling back to ${env.VERTEX_MODEL_FALLBACK}`);

  try {
    const fb = await callModel(env.VERTEX_MODEL_FALLBACK, input);
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
      `Vertex Gemini primary (${env.VERTEX_MODEL_PRIMARY}) AND fallback (${env.VERTEX_MODEL_FALLBACK}) both failed. Primary: ${serialize(lastError)} | Fallback: ${serialize(err)}`,
      { primary: serialize(lastError), fallback: serialize(err) }
    );
  }
}

async function callModel(
  modelName: string,
  input: GeminiCallInput
): Promise<{ text: string; modelUsed: string }> {
  const callPromise = client.models.generateContent({
    model: modelName,
    contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
    config: {
      temperature: input.temperature ?? 0.4,
      maxOutputTokens: input.maxOutputTokens ?? 1024,
      ...(input.systemInstruction
        ? { systemInstruction: { role: 'system', parts: [{ text: input.systemInstruction }] } }
        : {}),
      ...(input.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
    },
  });

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

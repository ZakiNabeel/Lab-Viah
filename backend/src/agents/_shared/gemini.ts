import { GoogleGenerativeAI, type GenerationConfig } from '@google/generative-ai';
import { env } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { AppError } from '../../utils/errors.js';
import { recover, type TraceBus } from './trace.js';

// =========================================================
// Gemini wrapper.
// Every agent calls Gemini ONLY through this module. We centralize:
//   - retry policy (2 attempts on the primary model)
//   - Pro -> Flash fallback (on rate-limit, timeout, or repeated failure)
//   - trace emissions for tool.call + tool.result
// See ANTIGRAVITY.md §3 and MASTERPLAN.md §9.
// =========================================================

const client = new GoogleGenerativeAI(env.GEMINI_API_KEY);

export type GeminiCallInput = {
  prompt: string;
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  // When true, fall back to Flash model after primary failure. Defaults to true.
  allowFallback?: boolean;
  // JSON-mode: parse the response as JSON before returning.
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
      model: env.GEMINI_MODEL_PRIMARY,
      promptChars: input.prompt.length,
      temperature: input.temperature,
    },
    ts: Date.now(),
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= PRIMARY_ATTEMPTS; attempt++) {
    try {
      const result = await callModel(env.GEMINI_MODEL_PRIMARY, input);
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
        { attempt, model: env.GEMINI_MODEL_PRIMARY, err: serialize(err) },
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
      `Gemini primary (${env.GEMINI_MODEL_PRIMARY}) failed and fallback disabled: ${serialize(lastError)}`,
      { cause: serialize(lastError) }
    );
  }

  if (bus) recover(bus, 'gemini primary exhausted', `falling back to ${env.GEMINI_MODEL_FALLBACK}`);

  try {
    const fb = await callModel(env.GEMINI_MODEL_FALLBACK, input);
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
      `Gemini primary (${env.GEMINI_MODEL_PRIMARY}) AND fallback (${env.GEMINI_MODEL_FALLBACK}) both failed. Primary: ${serialize(lastError)} | Fallback: ${serialize(err)}`,
      { primary: serialize(lastError), fallback: serialize(err) }
    );
  }
}

async function callModel(
  modelName: string,
  input: GeminiCallInput
): Promise<{ text: string; modelUsed: string }> {
  const generationConfig: GenerationConfig = {
    temperature: input.temperature ?? 0.4,
    maxOutputTokens: input.maxOutputTokens ?? 1024,
    ...(input.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
  };

  const model = client.getGenerativeModel({
    model: modelName,
    ...(input.systemInstruction ? { systemInstruction: input.systemInstruction } : {}),
    generationConfig,
  });

  const callPromise = model.generateContent(input.prompt);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new AppError('TIMEOUT', `Gemini ${modelName} exceeded ${PRIMARY_TIMEOUT_MS}ms`)),
      PRIMARY_TIMEOUT_MS
    )
  );

  const result = await Promise.race([callPromise, timeoutPromise]);
  const text = result.response.text();
  if (!text) {
    throw new AppError('UPSTREAM_FAILURE', `Gemini ${modelName} returned empty response`);
  }
  return { text, modelUsed: modelName };
}

function serialize(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// =========================================================
// Smoke test — used by /health and Session 1 exit-check.
// =========================================================
export async function geminiSmokeTest(): Promise<{
  ok: boolean;
  modelUsed?: string;
  latencyMs?: number;
  error?: string;
}> {
  try {
    // maxOutputTokens needs headroom because 2.5+/3.x Gemini models consume the
    // token budget for internal "thinking" before producing visible output. With
    // a tiny cap (e.g. 8) the model thinks itself out before any reply lands and
    // returns an empty response. 256 is comfortably above all observed thinking
    // budgets while keeping the smoke test cheap.
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

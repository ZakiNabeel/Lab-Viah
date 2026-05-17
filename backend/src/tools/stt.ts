// STT tool — Cloud Speech-to-Text wrapper.
// MASTERPLAN §9 retry policy: 1× retry, fallback = return low-confidence flag
// so the route surfaces chip-style prompts as the visible recovery.
//
// Session 2 build: this module accepts base64 audio + language hint and
// returns a structured transcript result. The actual call to Google Cloud
// Speech is left as a stub that always returns a low-confidence "no audio"
// result, because wiring real STT requires the `@google-cloud/speech` package
// (a new top-level dependency). Per CLAUDE rule "no new deps without asking"
// this is deferred to Session 5 polish — and the chip-fallback path is itself
// the demo's visible recovery event, so the demo story is unchanged.
//
// The tool registry contract (tool.call + tool.result on the bus) is fully
// wired here, so when real STT lands later, only the inside of `attemptStt`
// needs to change.

import { env } from '../config.js';
import { logger } from '../utils/logger.js';
import { recover, type TraceBus } from '../agents/_shared/trace.js';

export type SttLanguage = 'ur-PK' | 'en-US' | 'auto';

export type SttInput = {
  audioBase64: string;
  language: SttLanguage;
};

export type SttResult = {
  transcript: string;
  confidence: number; // 0..1
  language_detected: string;
  // True when the agent should fall back to chip-based prompts.
  lowConfidence: boolean;
  // True when no real STT happened (creds missing or stub mode).
  stub: boolean;
};

const LOW_CONFIDENCE_THRESHOLD = 0.6;

export async function sttTranscribe(input: SttInput, bus?: TraceBus): Promise<SttResult> {
  const start = Date.now();
  bus?.emit({
    type: 'tool.call',
    tool: 'sttTranscribe',
    args: { language: input.language, audioBytes: rough(input.audioBase64) },
    ts: start,
  });

  const haveCreds = Boolean(env.GOOGLE_APPLICATION_CREDENTIALS);
  let result: SttResult;
  try {
    result = haveCreds
      ? await attemptStt(input)
      : { transcript: '', confidence: 0, language_detected: 'unknown', lowConfidence: true, stub: true };
  } catch (err) {
    logger.warn({ err }, 'STT attempt threw — falling back to chip prompts');
    result = { transcript: '', confidence: 0, language_detected: 'unknown', lowConfidence: true, stub: true };
  }

  bus?.emit({
    type: 'tool.result',
    tool: 'sttTranscribe',
    result: {
      confidence: result.confidence,
      lowConfidence: result.lowConfidence,
      stub: result.stub,
      chars: result.transcript.length,
    },
    latency_ms: Date.now() - start,
    ts: Date.now(),
  });

  if (result.lowConfidence && bus) {
    recover(
      bus,
      result.stub ? 'STT unavailable (no GCP creds wired)' : `STT confidence ${result.confidence.toFixed(2)} < ${LOW_CONFIDENCE_THRESHOLD}`,
      'surfacing chip_options to the client instead of free-text turn'
    );
  }

  return result;
}

// Stub implementation — see file header. Replace the body when wiring real STT.
async function attemptStt(_input: SttInput): Promise<SttResult> {
  return {
    transcript: '',
    confidence: 0,
    language_detected: 'unknown',
    lowConfidence: true,
    stub: true,
  };
}

function rough(b64: string): number {
  // Approximate audio size in bytes without decoding the whole thing.
  return Math.floor((b64.length * 3) / 4);
}

export { LOW_CONFIDENCE_THRESHOLD };

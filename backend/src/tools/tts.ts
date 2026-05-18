// TTS tool — Google Cloud Text-to-Speech wrapper.
// MASTERPLAN §5.6 (Wali Agent — Urdu/English spoken rishta brief) + §9
// (1× retry, fallback = skip audio, send text only).
//
// Auth: ADC via GOOGLE_APPLICATION_CREDENTIALS (same service-account JSON used
// by Vertex AI). The SA needs the `Cloud Text-to-Speech User` role, or the
// broader `Cloud Text-to-Speech Service Agent`.
//
// Output: base64 data URI (data:audio/mp3;base64,...) — directly playable in
// the Expo mobile client via expo-av without needing object storage. Keeps the
// demo single-process; if we ever need durable hosting we can pipe the same
// bytes into Supabase Storage in Session 5 polish.
//
// Tool registry contract is fully wired even when audio is skipped — every
// invocation emits tool.call + tool.result (and a recovery event when the
// fallback fires). See ANTIGRAVITY.md §3.

import { env } from '../config.js';
import { logger } from '../utils/logger.js';
import { recover, type TraceBus } from '../agents/_shared/trace.js';

// Lazy import + lazy client — keeps the server bootable when GCP creds are
// missing (the missing-creds branch then short-circuits to text-only with a
// recovery event before ever touching the SDK).
type TtsClient = {
  synthesizeSpeech(req: SynthesizeRequest): Promise<[SynthesizeResponse]>;
};

type SynthesizeRequest = {
  input: { text: string };
  voice: { languageCode: string; name: string; ssmlGender?: 'MALE' | 'FEMALE' | 'NEUTRAL' };
  audioConfig: { audioEncoding: 'MP3'; speakingRate?: number; pitch?: number };
};

type SynthesizeResponse = {
  audioContent?: string | Uint8Array | null;
};

let cachedClient: TtsClient | null = null;
async function getClient(): Promise<TtsClient> {
  if (cachedClient) return cachedClient;
  const mod = await import('@google-cloud/text-to-speech');
  const Ctor = mod.TextToSpeechClient;
  cachedClient = new Ctor() as unknown as TtsClient;
  return cachedClient;
}

// =========================================================
// Public types
// =========================================================

export type TtsLanguage = 'ur' | 'ro_ur' | 'en';

export type TtsInput = {
  text: string;
  language: TtsLanguage;
  // Optional gender hint. Wali briefs default to MALE (wali is typically the
  // father/uncle); the Wali Agent passes this explicitly.
  gender?: 'MALE' | 'FEMALE';
};

export type TtsResult = {
  // Either a data:audio/mp3;base64,... URI or null when audio was skipped.
  audioDataUri: string | null;
  // Approximate bytes of decoded audio (for the trace summary).
  audioBytes: number;
  // The voice that was used (e.g. 'ur-IN-Wavenet-B').
  voiceUsed: string | null;
  // True when the audio path was skipped (missing creds, API failure, etc.).
  textOnly: boolean;
  // Why audio was skipped, if it was.
  skipReason: string | null;
};

// =========================================================
// Voice selection
// =========================================================
//
// Roman Urdu uses the same TTS voice as Urdu — the Latin transliteration is
// just for the visual brief; the spoken brief reads the underlying Urdu text
// the Wali Agent passes in. The agent is responsible for passing the SCRIPT
// the caller wants spoken; this tool does NOT transliterate.

const VOICES = {
  ur: {
    MALE: { languageCode: 'ur-IN', name: 'ur-IN-Wavenet-B', gender: 'MALE' as const },
    FEMALE: { languageCode: 'ur-IN', name: 'ur-IN-Wavenet-A', gender: 'FEMALE' as const },
  },
  ro_ur: {
    MALE: { languageCode: 'ur-IN', name: 'ur-IN-Wavenet-B', gender: 'MALE' as const },
    FEMALE: { languageCode: 'ur-IN', name: 'ur-IN-Wavenet-A', gender: 'FEMALE' as const },
  },
  en: {
    MALE: { languageCode: 'en-US', name: 'en-US-Wavenet-D', gender: 'MALE' as const },
    FEMALE: { languageCode: 'en-US', name: 'en-US-Wavenet-F', gender: 'FEMALE' as const },
  },
} as const;

// Tight: a wali brief is 80-300 words = ~30-120s of audio at default rate. We
// cap text to ~1500 chars to keep latency under 4s and avoid runaway billing
// (TTS is ~$16/M chars on Wavenet).
const MAX_TEXT_CHARS = 1500;
const PER_ATTEMPT_TIMEOUT_MS = 8_000;

// =========================================================
// Public API
// =========================================================

export async function ttsSynthesize(input: TtsInput, bus?: TraceBus): Promise<TtsResult> {
  const start = Date.now();
  const gender = input.gender ?? 'MALE';
  const voice = VOICES[input.language][gender];
  const text = (input.text ?? '').trim();
  const truncated = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;

  bus?.emit({
    type: 'tool.call',
    tool: 'ttsSynthesize',
    args: {
      language: input.language,
      gender,
      voice: voice.name,
      textChars: truncated.length,
      truncated: truncated.length < text.length,
    },
    ts: start,
  });

  if (!truncated) {
    const result: TtsResult = {
      audioDataUri: null,
      audioBytes: 0,
      voiceUsed: null,
      textOnly: true,
      skipReason: 'empty input text',
    };
    emitResult(bus, result, start);
    if (bus) recover(bus, 'TTS called with empty text', 'returning text-only result, no synthesis attempted');
    return result;
  }

  const haveCreds = Boolean(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (!haveCreds) {
    const result: TtsResult = {
      audioDataUri: null,
      audioBytes: 0,
      voiceUsed: null,
      textOnly: true,
      skipReason: 'GOOGLE_APPLICATION_CREDENTIALS not configured',
    };
    emitResult(bus, result, start);
    if (bus) recover(bus, 'TTS credentials missing', 'returning text-only Wali brief; client will render text, no audio playback');
    return result;
  }

  // 2 attempts, 600ms backoff. TTS is mostly reliable but Google occasionally
  // returns 503 under burst; one retry is cheap.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const audioBytes = await synthesizeOnce({
        text: truncated,
        voice: voice.name,
        languageCode: voice.languageCode,
        gender: voice.gender,
      });
      const dataUri = `data:audio/mp3;base64,${Buffer.from(audioBytes).toString('base64')}`;
      const result: TtsResult = {
        audioDataUri: dataUri,
        audioBytes: audioBytes.byteLength,
        voiceUsed: voice.name,
        textOnly: false,
        skipReason: null,
      };
      emitResult(bus, result, start);
      return result;
    } catch (err) {
      lastErr = err;
      logger.warn(
        { attempt, err: err instanceof Error ? err.message : String(err), voice: voice.name },
        'TTS attempt failed'
      );
      if (attempt < 2) await sleep(600);
    }
  }

  // Both attempts failed — fall back to text-only.
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const result: TtsResult = {
    audioDataUri: null,
    audioBytes: 0,
    voiceUsed: null,
    textOnly: true,
    skipReason: `TTS attempts exhausted: ${reason.slice(0, 200)}`,
  };
  emitResult(bus, result, start);
  if (bus) recover(bus, `TTS failed after 2 attempts: ${reason.slice(0, 120)}`, 'returning text-only Wali brief; client will skip audio playback');
  return result;
}

// =========================================================
// One synthesis attempt with timeout
// =========================================================

async function synthesizeOnce(opts: {
  text: string;
  voice: string;
  languageCode: string;
  gender: 'MALE' | 'FEMALE' | 'NEUTRAL';
}): Promise<Uint8Array> {
  const client = await getClient();
  const callPromise: Promise<[SynthesizeResponse]> = client.synthesizeSpeech({
    input: { text: opts.text },
    voice: { languageCode: opts.languageCode, name: opts.voice, ssmlGender: opts.gender },
    audioConfig: { audioEncoding: 'MP3', speakingRate: 0.95 },
  });
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`TTS exceeded ${PER_ATTEMPT_TIMEOUT_MS}ms`)), PER_ATTEMPT_TIMEOUT_MS)
  );
  const [response] = await Promise.race([callPromise, timeoutPromise]);
  const audio = response.audioContent;
  if (!audio) throw new Error('TTS returned empty audioContent');
  return typeof audio === 'string' ? Buffer.from(audio, 'base64') : audio;
}

// =========================================================
// Helpers
// =========================================================

function emitResult(bus: TraceBus | undefined, result: TtsResult, start: number): void {
  bus?.emit({
    type: 'tool.result',
    tool: 'ttsSynthesize',
    result: {
      textOnly: result.textOnly,
      voiceUsed: result.voiceUsed,
      audioBytes: result.audioBytes,
      hasDataUri: result.audioDataUri !== null,
      skipReason: result.skipReason,
    },
    latency_ms: Date.now() - start,
    ts: Date.now(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

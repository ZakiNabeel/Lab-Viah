// STT tool — Google Cloud Speech-to-Text wrapper.
// MASTERPLAN §9 retry policy: 1× retry, fallback = return low-confidence flag
// so the route surfaces chip-style prompts as the visible recovery.
//
// Auth: ADC via GOOGLE_APPLICATION_CREDENTIALS (same service-account JSON used
// by Vertex AI / TTS). The SA needs the `Cloud Speech-to-Text User` role.
//
// Encoding: detected from the audio's magic bytes so the same endpoint works
// for iOS (WAV LINEAR16) and Android (AMR_WB) without the frontend needing to
// announce its format. Headered formats (WAV, FLAC, OGG) fall through to
// ENCODING_UNSPECIFIED which lets Google parse the header itself.
//
// Languages: `ur-PK` → primary Urdu with English alternative (handles
// code-switching), `en-US` → primary English with Urdu alternative, `auto` →
// equal weighting. Roman Urdu is treated as auto since it's typed in Latin
// script but contains Urdu phonemes.

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
const PER_ATTEMPT_TIMEOUT_MS = 10_000;

// Lazy import + lazy client — keeps the server bootable when GCP creds are
// missing (the missing-creds branch short-circuits to stub before ever touching
// the SDK). Matches the pattern in tools/tts.ts.
type RecognizeRequest = {
  audio: { content: string };
  config: {
    encoding: string;
    sampleRateHertz?: number;
    languageCode: string;
    alternativeLanguageCodes?: string[];
    enableAutomaticPunctuation?: boolean;
    audioChannelCount?: number;
  };
};

type RecognizeResponse = {
  results?: Array<{
    alternatives?: Array<{
      transcript?: string | null;
      confidence?: number | null;
    }>;
    languageCode?: string | null;
  }>;
};

type SpeechClient = {
  recognize(req: RecognizeRequest): Promise<[RecognizeResponse]>;
};

let cachedClient: SpeechClient | null = null;
async function getClient(): Promise<SpeechClient> {
  if (cachedClient) return cachedClient;
  const mod = await import('@google-cloud/speech');
  const Ctor = mod.SpeechClient;
  cachedClient = new Ctor() as unknown as SpeechClient;
  return cachedClient;
}

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
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'STT attempt threw — falling back to chip prompts');
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
      language_detected: result.language_detected,
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

async function attemptStt(input: SttInput): Promise<SttResult> {
  const audioBuf = Buffer.from(input.audioBase64, 'base64');
  if (audioBuf.byteLength < 256) {
    // Audio too small to be a real utterance — skip the round-trip.
    return { transcript: '', confidence: 0, language_detected: 'unknown', lowConfidence: true, stub: false };
  }

  const { encoding, sampleRateHertz } = detectEncoding(audioBuf);
  const { primaryLang, alternativeLangs } = languageConfig(input.language);

  const client = await getClient();
  const config: RecognizeRequest['config'] = {
    encoding,
    languageCode: primaryLang,
    alternativeLanguageCodes: alternativeLangs,
    enableAutomaticPunctuation: true,
    audioChannelCount: 1,
    // No `model` set → Google picks the default for the language. `latest_short`
    // and `latest_long` are English-/major-language-only; setting either for
    // ur-PK returns "Invalid recognition 'config': The requested model is
    // currently not supported for language : ur-PK." (verified in Railway
    // logs). Default model supports ur-PK + en-US fine.
  };
  if (sampleRateHertz > 0) config.sampleRateHertz = sampleRateHertz;

  const callPromise: Promise<[RecognizeResponse]> = client.recognize({
    audio: { content: input.audioBase64 },
    config,
  });
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`STT exceeded ${PER_ATTEMPT_TIMEOUT_MS}ms`)), PER_ATTEMPT_TIMEOUT_MS)
  );
  const [response] = await Promise.race([callPromise, timeoutPromise]);

  const result = response.results?.[0];
  const best = result?.alternatives?.[0];
  const transcript = (best?.transcript ?? '').trim();
  const confidence = typeof best?.confidence === 'number' ? best.confidence : 0;
  const language_detected = result?.languageCode ?? primaryLang;
  const lowConfidence = !transcript || confidence < LOW_CONFIDENCE_THRESHOLD;

  return { transcript, confidence, language_detected, lowConfidence, stub: false };
}

function detectEncoding(bytes: Buffer): { encoding: string; sampleRateHertz: number } {
  // RIFF/WAVE — read sampleRate from header at offset 24 (LE uint32).
  if (
    bytes.length >= 44 &&
    bytes.slice(0, 4).toString('ascii') === 'RIFF' &&
    bytes.slice(8, 12).toString('ascii') === 'WAVE'
  ) {
    const sampleRate = bytes.readUInt32LE(24);
    return { encoding: 'LINEAR16', sampleRateHertz: sampleRate || 16000 };
  }
  // AMR Wide Band — "#!AMR-WB\n"
  if (bytes.length >= 9 && bytes.slice(0, 9).toString('ascii') === '#!AMR-WB\n') {
    return { encoding: 'AMR_WB', sampleRateHertz: 16000 };
  }
  // AMR Narrow Band — "#!AMR\n"
  if (bytes.length >= 6 && bytes.slice(0, 6).toString('ascii') === '#!AMR\n') {
    return { encoding: 'AMR', sampleRateHertz: 8000 };
  }
  // FLAC, OGG, MP3, WEBM — Google can auto-detect headered formats.
  return { encoding: 'ENCODING_UNSPECIFIED', sampleRateHertz: 0 };
}

function languageConfig(lang: SttLanguage): { primaryLang: string; alternativeLangs: string[] } {
  if (lang === 'ur-PK') return { primaryLang: 'ur-PK', alternativeLangs: ['en-US'] };
  if (lang === 'en-US') return { primaryLang: 'en-US', alternativeLangs: ['ur-PK'] };
  // auto / ro_ur — equal weighting, Urdu primary because the chat skews Urdu.
  return { primaryLang: 'ur-PK', alternativeLangs: ['en-US'] };
}

function rough(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

export { LOW_CONFIDENCE_THRESHOLD };

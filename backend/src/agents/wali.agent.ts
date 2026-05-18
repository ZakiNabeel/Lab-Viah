// Wali Agent — MASTERPLAN §5.6.
//
// One entry point — `runWaliBrief` — that produces the rishta brief documents
// in BOTH English and the user's native language (Urdu or Roman Urdu), with
// synthesized audio for each. Designed to be called once per top-3 reveal
// inside the book_meeting workplan.
//
// The two brief generations run in parallel (2 of the 10 Gemini concurrency
// slots) followed by the two TTS calls in parallel. Total wall-clock
// budget ≈ Pro brief (≈4s) + TTS (≈2s) = ~6-8s on a warm Vertex.
//
// Failure modes (per §5.6):
//   - Missing wali contact → caller substitutes the user as their own wali
//     (the agent itself doesn't dispatch; it returns documents + audio +
//     rendered SMS, all of which the workplan persists/displays).
//   - Gemini fails one or both languages → deterministic fallback brief from
//     fallbackBrief() in the prompt file, recovery event emitted.
//   - TTS fails → text-only brief shipped, recovery event emitted (the TTS
//     tool already emits the recovery; we surface it through the agent's
//     decision log).

import { z } from 'zod';
import { geminiCall } from './_shared/gemini.js';
import { decide, obs, recover, taskEnd, taskStart, type TraceBus } from './_shared/trace.js';
import { logger } from '../utils/logger.js';
import {
  buildWaliBriefPrompt,
  fallbackBrief,
  flattenForSpeech,
  type WaliBriefDocument,
  type WaliBriefLanguage,
} from '../content/prompts/wali.prompt.js';
import { ttsSynthesize, type TtsResult } from '../tools/tts.js';
import { smsRender, type SmsRenderResult } from '../tools/sms.template.js';
import type { CompatibilityReport } from '../domain/scoring.js';
import type { TwinSpec } from '../domain/twin.js';

// =========================================================
// Schemas
// =========================================================

const BriefSchema = z.object({
  salutation: z.string().min(1).max(200),
  headline: z.string().min(1).max(300),
  candidate_summary: z.string().min(1).max(900),
  alignment_points: z.array(z.string().min(1).max(220)).min(2).max(5),
  discussion_points: z.array(z.string().min(1).max(280)).min(1).max(5),
  recommended_next_step: z.string().min(1).max(300),
  compatibility_label: z.string().min(1).max(80),
});

// =========================================================
// Public types
// =========================================================

export type WaliRelation = 'father' | 'uncle' | 'brother' | 'guardian';

export type WaliBriefInput = {
  userFirstName: string;
  userSpec: TwinSpec;
  candidateSpec: TwinSpec;
  report: CompatibilityReport;
  userWaliName: string;
  userWaliRelation: WaliRelation;
  userWaliPhone: string;
  candidateWaliName: string;
  candidateWaliPhone: string;
  // The user's native script. The "other" brief is always English so the
  // demo always has an English copy on hand.
  nativeLanguage: 'ur' | 'ro_ur';
};

export type WaliBriefBundle = {
  language: WaliBriefLanguage;
  document: WaliBriefDocument;
  spokenText: string;        // What was sent to TTS (already flattened).
  audio: TtsResult;
  // SMS rendered to the wali for this language. Mock — not actually sent.
  walisSms: SmsRenderResult;
  briefFromFallback: boolean;
};

export type WaliBriefOutput = {
  briefs: WaliBriefBundle[];   // length 2: English + native.
  generatedAt: string;
};

// =========================================================
// Entry point
// =========================================================

export async function runWaliBrief(input: WaliBriefInput, bus: TraceBus): Promise<WaliBriefOutput> {
  const task = `wali_brief:${input.candidateSpec.identity.name}`;
  taskStart(bus, task);
  obs(
    bus,
    'wali',
    `composing wali brief for ${input.userFirstName} × ${input.candidateSpec.identity.name} (overall=${input.report.overall_score.toFixed(2)}, ${input.report.recommendation})`
  );

  // Step 1: generate EN and native-language briefs in parallel.
  const [enBundle, nativeBundle] = await Promise.all([
    generateOneLanguage('en', input, bus),
    generateOneLanguage(input.nativeLanguage, input, bus),
  ]);

  // Step 2: render mock SMS to the user's wali in both languages so the
  // mobile UI can show the "delivered SMS" preview in either script.
  const enSms = await renderWaliSms('en', input, enBundle.document, bus);
  const nativeSms = await renderWaliSms(input.nativeLanguage, input, nativeBundle.document, bus);
  enBundle.walisSms = enSms;
  nativeBundle.walisSms = nativeSms;

  decide(
    bus,
    'wali',
    `wali briefs ready (${enBundle.briefFromFallback ? 'EN=fallback' : 'EN=ok'}, ${nativeBundle.briefFromFallback ? `${input.nativeLanguage}=fallback` : `${input.nativeLanguage}=ok`})`,
    `audio: EN=${enBundle.audio.textOnly ? 'text-only' : 'mp3'}, ${input.nativeLanguage}=${nativeBundle.audio.textOnly ? 'text-only' : 'mp3'}; SMS: 2 rendered (mocked)`
  );

  const output: WaliBriefOutput = {
    briefs: [enBundle, nativeBundle],
    generatedAt: new Date().toISOString(),
  };

  taskEnd(bus, task, {
    languages: output.briefs.map((b) => b.language),
    audio_ok: output.briefs.map((b) => !b.audio.textOnly),
    used_fallback: output.briefs.map((b) => b.briefFromFallback),
  });

  return output;
}

// =========================================================
// One-language brief generator
// =========================================================

async function generateOneLanguage(
  language: WaliBriefLanguage,
  input: WaliBriefInput,
  bus: TraceBus
): Promise<WaliBriefBundle> {
  const promptArgs = {
    language,
    userSpec: input.userSpec,
    candidateSpec: input.candidateSpec,
    report: input.report,
    waliName: input.userWaliName,
    waliRelation: input.userWaliRelation,
    userFirstName: input.userFirstName,
  };

  let document: WaliBriefDocument;
  let usedFallback = false;
  try {
    const gem = await geminiCall(
      {
        prompt: buildWaliBriefPrompt(promptArgs),
        // Pro on Wali briefs — 2 calls per /book/initiate, low volume, quality
        // matters. Urdu in particular drops off sharply on Flash without
        // thinking.
        modelTier: 'pro',
        temperature: 0.55,
        maxOutputTokens: 1400,
        responseFormat: 'json',
      },
      bus
    );
    const parsed = BriefSchema.parse(JSON.parse(gem.text));
    document = {
      ...parsed,
      _pct: (input.report.overall_score * 100).toFixed(0),
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), language },
      'wali brief: Gemini call or schema failed; using deterministic fallback'
    );
    recover(
      bus,
      `wali brief generation failed for language=${language}`,
      'using deterministic fallback brief derived from spec + per-dim evidence'
    );
    document = fallbackBrief(promptArgs);
    usedFallback = true;
  }

  // Step 2: synthesize audio (text-only fallback inside the TTS tool itself).
  const spokenText = flattenForSpeech(document, language);
  const audio = await ttsSynthesize(
    {
      text: spokenText,
      language,
      gender: input.userWaliRelation === 'father' || input.userWaliRelation === 'uncle' || input.userWaliRelation === 'brother' ? 'MALE' : 'MALE',
    },
    bus
  );

  obs(
    bus,
    'wali',
    `brief[${language}] ready (chars=${spokenText.length}, audio=${audio.textOnly ? 'text-only' : audio.voiceUsed}, fallback=${usedFallback})`
  );

  // walisSms is filled in by the caller (we need the document first).
  return {
    language,
    document,
    spokenText,
    audio,
    walisSms: emptySms(language),
    briefFromFallback: usedFallback,
  };
}

// =========================================================
// SMS to wali — uses the wali_brief_intro template
// =========================================================

async function renderWaliSms(
  language: WaliBriefLanguage,
  input: WaliBriefInput,
  _document: WaliBriefDocument,
  bus: TraceBus
): Promise<SmsRenderResult> {
  return smsRender(
    {
      template: 'wali_brief_intro',
      toRole: 'wali_user',
      toPhone: input.userWaliPhone,
      toName: input.userWaliName,
      language,
      vars: {
        userName: input.userFirstName,
        userAge: input.userSpec.identity.age,
        userCity: input.userSpec.identity.city,
        candidateName: input.candidateSpec.identity.name,
        candidateAge: input.candidateSpec.identity.age,
        candidateCity: input.candidateSpec.identity.city,
        compatibilityPct: Math.round(input.report.overall_score * 100),
      },
    },
    bus
  );
}

// Stub SMS for the first-pass return; replaced before the bundle leaves the
// agent. Keeps the type-checker happy without making walisSms optional.
function emptySms(language: WaliBriefLanguage): SmsRenderResult {
  return {
    body: '',
    segments: 0,
    language,
    template: 'wali_brief_intro',
    sentAt: new Date(0).toISOString(),
    delivered: true,
    mocked: true,
  };
}

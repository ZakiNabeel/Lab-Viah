// Onboarding Agent — MASTERPLAN §5.1.
//
// One agent invocation = one chat turn. Input: user message + accumulated
// payload + turn count. Output: structured fields + next prompt + confidence.
// The agent is stateless across turns; state lives in the OnboardingSession.

import { z } from 'zod';
import { geminiCall } from './_shared/gemini.js';
import { decide, obs, recover, type TraceBus } from './_shared/trace.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { sttTranscribe } from '../tools/stt.js';
import {
  buildOnboardingSystemPrompt,
  buildOnboardingTurnPrompt,
} from '../content/prompts/onboarding.prompt.js';
import type { OnboardingSession } from '../domain/onboarding-session.js';
import type { LanguagePref } from '../domain/twin.js';

// =========================================================
// Output schema — what Gemini must return per turn.
// =========================================================
const ExtractedSchema = z
  .object({
    identity: z
      .object({
        name: z.string().optional(),
        age: z.number().int().optional(),
        gender: z.enum(['male', 'female']).optional(),
        city: z.string().optional(),
      })
      .partial()
      .optional(),
    deen_level: z.enum(['strict', 'practicing', 'moderate', 'cultural', 'secular']).optional(),
    family_setup: z.enum(['joint', 'nuclear', 'single_parent']).optional(),
    career: z
      .object({
        current: z.string().optional(),
        five_yr_goal: z.string().optional(),
      })
      .partial()
      .optional(),
    kids_timeline: z.enum(['asap', '2-3_yrs', '5_plus', 'none']).optional(),
    geography: z
      .object({
        current_city: z.string().optional(),
        ten_yr_pref: z.string().optional(),
        flexible: z.boolean().optional(),
      })
      .partial()
      .optional(),
    dealbreakers: z.array(z.string()).optional(),
  })
  .partial();

const TurnOutputSchema = z.object({
  reply: z.string().min(1),
  extracted: ExtractedSchema,
  confidence: z.number().min(0).max(1),
  next_topic: z.enum([
    'identity',
    'deen',
    'family',
    'career',
    'kids',
    'geography',
    'dealbreakers',
    'done',
  ]),
  chip_options: z.array(z.string()).optional(),
});

export type OnboardingTurnInput = {
  session: OnboardingSession;
  // Exactly one of `text` or `audioBase64` is set.
  text?: string;
  audioBase64?: string;
  history: { role: 'user' | 'agent'; content: string }[];
};

export type OnboardingTurnResult = z.infer<typeof TurnOutputSchema> & {
  sttConfidence?: number;
  sttStub?: boolean;
};

const LOW_LLM_CONFIDENCE = 0.6;
const MAX_TURNS = 5;

export async function runOnboardingTurn(
  input: OnboardingTurnInput,
  bus: TraceBus
): Promise<OnboardingTurnResult> {
  const { session } = input;
  obs(bus, 'onboarding', `turn ${session.layer1Turns + 1}/${MAX_TURNS}, language=${session.language}`);

  if (session.layer1Turns >= MAX_TURNS) {
    decide(
      bus,
      'onboarding',
      'force layer 1 to terminate',
      `reached MAX_TURNS=${MAX_TURNS}; mark next_topic=done and let route advance`
    );
  }

  // -------- Resolve user message --------
  let userText = input.text?.trim() ?? '';
  let sttConfidence: number | undefined;
  let sttStub: boolean | undefined;

  if (!userText && input.audioBase64) {
    obs(bus, 'onboarding', 'audio chunk provided; running STT before LLM turn');
    const stt = await sttTranscribe(
      { audioBase64: input.audioBase64, language: sttLangFor(session.language) },
      bus
    );
    sttConfidence = stt.confidence;
    sttStub = stt.stub;
    userText = stt.transcript;

    if (stt.lowConfidence || !userText) {
      // Chip-fallback path — the visible recovery from §5.1 failure modes.
      decide(
        bus,
        'onboarding',
        'short-circuit LLM turn, return chip prompts',
        stt.stub
          ? 'STT stub returned no transcript; ask user to tap a chip instead'
          : `STT confidence ${stt.confidence.toFixed(2)} below threshold`
      );
      return {
        reply: chipFallbackReply(session.language),
        extracted: {},
        confidence: 0,
        next_topic: pickNextTopic(session),
        chip_options: chipOptionsFor(session),
        ...(sttConfidence !== undefined ? { sttConfidence } : {}),
        ...(sttStub !== undefined ? { sttStub } : {}),
      };
    }
  }

  if (!userText) {
    throw new AppError('BAD_REQUEST', 'Either `text` or `audioBase64` is required');
  }

  obs(bus, 'onboarding', `user said: ${truncate(userText, 80)}`);

  // -------- LLM turn --------
  const systemPrompt = buildOnboardingSystemPrompt(session.language);
  const prompt = buildOnboardingTurnPrompt({
    history: input.history,
    knownFields: session.payload,
    turn: session.layer1Turns + 1,
    userMessage: userText,
  });

  const gem = await geminiCall(
    {
      prompt,
      systemInstruction: systemPrompt,
      temperature: 0.4,
      maxOutputTokens: 768,
      responseFormat: 'json',
    },
    bus
  );

  let parsed: z.infer<typeof TurnOutputSchema>;
  try {
    parsed = TurnOutputSchema.parse(JSON.parse(gem.text));
  } catch (err) {
    logger.warn(
      { err, raw: gem.text.slice(0, 400) },
      'onboarding agent: Gemini response failed schema; retrying once with chip-fallback'
    );
    recover(
      bus,
      'malformed JSON from Gemini onboarding turn',
      'returning chip_options instead of free-text reply'
    );
    return {
      reply: chipFallbackReply(session.language),
      extracted: {},
      confidence: 0,
      next_topic: pickNextTopic(session),
      chip_options: chipOptionsFor(session),
      ...(sttConfidence !== undefined ? { sttConfidence } : {}),
      ...(sttStub !== undefined ? { sttStub } : {}),
    };
  }

  if (parsed.confidence < LOW_LLM_CONFIDENCE && !parsed.chip_options?.length) {
    // The prompt says "chip_options REQUIRED when confidence < 0.6". If the
    // model forgot, we synthesize defaults rather than asking the user to
    // free-type into ambiguity.
    recover(
      bus,
      `LLM returned confidence ${parsed.confidence.toFixed(2)} without chip_options`,
      'attaching default chip_options for current topic'
    );
    parsed = { ...parsed, chip_options: chipOptionsFor(session) };
  }

  decide(
    bus,
    'onboarding',
    `next_topic=${parsed.next_topic}`,
    `LLM confidence ${parsed.confidence.toFixed(2)}; extracted ${countExtracted(parsed.extracted)} field(s) this turn`
  );

  return {
    ...parsed,
    ...(sttConfidence !== undefined ? { sttConfidence } : {}),
    ...(sttStub !== undefined ? { sttStub } : {}),
  };
}

// =========================================================
// Helpers
// =========================================================

function sttLangFor(pref: LanguagePref): 'ur-PK' | 'en-US' | 'auto' {
  if (pref === 'ur') return 'ur-PK';
  if (pref === 'en') return 'en-US';
  return 'auto';
}

function chipFallbackReply(lang: LanguagePref): string {
  if (lang === 'ur') return 'مجھے ٹھیک سے سمجھ نہیں آیا۔ نیچے سے ایک آپشن منتخب کریں:';
  if (lang === 'ro_ur') return 'Maaf kijiye, samjha nahi. Neechay se aik option chunein:';
  return "Sorry, I didn't catch that. Pick one of these to continue:";
}

function pickNextTopic(session: OnboardingSession): z.infer<typeof TurnOutputSchema>['next_topic'] {
  // Priority order — first unfilled wins.
  const order = ['identity', 'deen', 'family', 'career', 'kids', 'geography', 'dealbreakers'] as const;
  const p = session.payload;
  if (!p.identity?.name || !p.identity?.age || !p.identity?.gender || !p.identity?.city)
    return 'identity';
  if (!p.deen_level) return 'deen';
  if (!p.family_setup) return 'family';
  if (!p.career?.current) return 'career';
  if (!p.kids_timeline) return 'kids';
  if (!p.geography?.current_city) return 'geography';
  if (!p.dealbreakers || p.dealbreakers.length === 0) return 'dealbreakers';
  // Exhausted — done.
  void order;
  return 'done';
}

function chipOptionsFor(session: OnboardingSession): string[] {
  const topic = pickNextTopic(session);
  const lang = session.language;
  const byTopic: Record<string, Record<LanguagePref, string[]>> = {
    identity: {
      en: ['My name is Ali, 28, male, Karachi', 'My name is Ayesha, 26, female, Lahore'],
      ro_ur: ['Mera naam Ali, 28, male, Karachi', 'Mera naam Ayesha, 26, female, Lahore'],
      ur: ['میرا نام علی، 28، مرد، کراچی', 'میرا نام عائشہ، 26، خاتون، لاہور'],
    },
    deen: {
      en: ['Strict practicing', 'Practicing', 'Moderate', 'Cultural'],
      ro_ur: ['Strict practicing', 'Practicing', 'Moderate', 'Cultural'],
      ur: ['پختہ دیندار', 'عمل پیرا', 'معتدل', 'ثقافتی'],
    },
    family: {
      en: ['Joint family', 'Nuclear family', 'Single parent'],
      ro_ur: ['Joint family', 'Nuclear family', 'Single parent'],
      ur: ['مشترکہ خاندان', 'نیوکلیئر', 'تنہا والد/والدہ'],
    },
    career: {
      en: ['Software engineer', 'Doctor', 'Teacher', 'Business owner'],
      ro_ur: ['Software engineer', 'Doctor', 'Teacher', 'Business owner'],
      ur: ['سافٹ ویئر انجینئر', 'ڈاکٹر', 'استاد', 'کاروبار'],
    },
    kids: {
      en: ['ASAP', '2-3 years', '5+ years', 'No kids'],
      ro_ur: ['ASAP', '2-3 saal', '5+ saal', 'No kids'],
      ur: ['فوراً', '2-3 سال', '5+ سال', 'بچے نہیں'],
    },
    geography: {
      en: ['Stay in Karachi', 'Move to Dubai', 'Move abroad', 'Flexible'],
      ro_ur: ['Karachi mein rahein', 'Dubai chalein', 'Foreign move', 'Flexible'],
      ur: ['کراچی میں', 'دبئی', 'بیرون ملک', 'لچک دار'],
    },
    dealbreakers: {
      en: ['No smoking', 'Must be practicing', 'No prior marriage', 'Open'],
      ro_ur: ['No smoking', 'Practicing zaroori', 'No prior marriage', 'Open'],
      ur: ['سگریٹ نہیں', 'دیندار لازمی', 'پہلی شادی نہ ہو', 'کوئی شرط نہیں'],
    },
  };
  return byTopic[topic]?.[lang] ?? byTopic['identity']![lang];
}

function countExtracted(e: Record<string, unknown>): number {
  let count = 0;
  for (const v of Object.values(e)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      count += Object.values(v).filter((x) => x !== undefined && x !== null).length;
    } else {
      count += 1;
    }
  }
  return count;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export { MAX_TURNS, LOW_LLM_CONFIDENCE };

// Twin Forge prompts — MASTERPLAN §5.2.
//
// Three responsibilities:
//   1. Generate 3 Layer-3 "interview statements" the user can confirm or
//      correct, drawn from the strongest signals in the Layer-1 payload +
//      Layer-2 personality vector.
//   2. Synthesize the final TwinSpec from all four layers.
//   3. Author the in-spec `system_prompt` (~400 words) that the User Twin and
//      Candidate Twin agents inject in Session 3.

import type { LanguagePref, TwinSpec } from '../../domain/twin.js';
import type { OnboardingSession } from '../../domain/onboarding-session.js';

const LANG_NOTE: Record<LanguagePref, string> = {
  en: 'Write the user-facing statements in English.',
  ur: 'صارف کو دکھائے جانے والے جملے اردو میں لکھیں۔',
  ro_ur: 'Write the user-facing statements in Roman Urdu (Latin letters).',
};

// =========================================================
// 1. Layer-3 interview statements
// =========================================================

export function buildTwinStatementsPrompt(session: OnboardingSession): string {
  const vec = JSON.stringify(session.personalityVector, null, 2);
  const payload = JSON.stringify(session.payload, null, 2);
  return `You are RishtaAI's Twin Forge. Generate THREE first-person interview statements
that a user with the profile below would likely agree or disagree with. These will
be shown for verification — picking sharp, opinionated statements is more useful
than safe ones, because disagreement teaches us more than agreement.

${LANG_NOTE[session.language]}

LAYER 1 PAYLOAD (structured extraction):
${payload}

LAYER 2 PERSONALITY VECTOR (signed per-dimension, range -1..1):
${vec}

Output a single JSON object:
{
  "statements": [
    { "dimension": "<one of: deen|family|career|finances|kids|conflict|geography|dealbreakers>",
      "statement": "<first-person, 1 sentence, opinionated>" },
    { "dimension": "...", "statement": "..." },
    { "dimension": "...", "statement": "..." }
  ]
}

Rules:
- Exactly 3 statements.
- Each statement must be in FIRST PERSON ("I would...", "Mujhe lagta hai...").
- Each must target a DIFFERENT dimension from the eight listed above.
- Pick the 3 dimensions with the strongest signal in the personality vector.
- Statements should be specific enough to disagree with — no platitudes.
- No quotation marks inside the statement.
- No markdown. No commentary outside the JSON.`;
}

// =========================================================
// 2. Final TwinSpec synthesis
// =========================================================

export function buildTwinSpecPrompt(session: OnboardingSession): string {
  const payload = JSON.stringify(session.payload, null, 2);
  const vector = JSON.stringify(session.personalityVector, null, 2);
  const cards = JSON.stringify(session.scenarioResponses, null, 2);
  const statements = JSON.stringify(session.twinStatements, null, 2);
  const wali = session.waliInput
    ? JSON.stringify(session.waliInput, null, 2)
    : '(none — user skipped Wali Mode)';
  const conflicts = JSON.stringify(session.waliConflicts, null, 2);

  return `You are RishtaAI's Twin Forge. Synthesize the FOUR layers below into a final TwinSpec
for matchmaking. The spec drives compatibility debates against other twins, so be
opinionated and specific — vague specs produce vague matches.

LAYER 1 PAYLOAD:
${payload}

LAYER 2 PERSONALITY VECTOR (signed, -1..1 per dimension):
${vector}

LAYER 2 SCENARIO RESPONSES (card_id + chosen option_id):
${cards}

LAYER 3 INTERVIEW STATEMENTS (with user agree/correct):
${statements}

LAYER 4 WALI INPUT:
${wali}

WALI vs USER CONFLICTS (do NOT auto-resolve — note in dealbreakers if relevant):
${conflicts}

Output a single JSON object matching this exact TypeScript shape (no extra keys):
{
  "identity": { "name": string, "age": number, "gender": "male"|"female", "city": string },
  "deen_level": "strict"|"practicing"|"moderate"|"cultural"|"secular",
  "family_setup": "joint"|"nuclear"|"single_parent",
  "family_loyalty_score": number,        // 0..1
  "career": { "current": string, "five_yr_goal": string, "ambition": number },  // ambition 0..1
  "finances": { "current_status": "student"|"starting"|"stable"|"affluent",
                "lifestyle_pref": "simple"|"comfortable"|"aspirational" },
  "kids_timeline": "asap"|"2-3_yrs"|"5_plus"|"none",
  "conflict_style": "avoidant"|"direct"|"consensus"|"elder_mediated",
  "geography": { "current_city": string, "ten_yr_pref": string, "flexible": boolean },
  "dealbreakers": string[],              // VERBATIM from user; never paraphrase
  "dimension_weights": {                 // 8 numbers, MUST sum to 1.0 (±0.01)
    "deen": number, "family": number, "career": number, "finances": number,
    "kids": number, "conflict": number, "geography": number, "dealbreakers": number
  }
}

Rules:
- Use ONLY values the user/wali actually provided. Never invent a dealbreaker.
- If a field is missing from all four layers, pick the most defensible default
  given the personality vector — do not leave required fields empty.
- dimension_weights MUST sum to 1.0. Bias weights toward the dimensions with
  strongest signal in the personality vector.
- If WALI vs USER conflicts exist, prefer the USER value but ADD a verbatim
  "wali wants: <wali_value>" entry to dealbreakers so it's visible downstream.
- No markdown. No commentary. JSON only.`;
}

// =========================================================
// 3. In-spec system_prompt for the Twin agent
// =========================================================
// This is the prompt the User Twin / Candidate Twin agents inject during
// Session 3 debates. It must capture VOICE (how this person argues) and
// VALUES (what they hold fixed). ~400 words is the MASTERPLAN target.

export function buildTwinVoicePrompt(spec: Omit<TwinSpec, 'system_prompt' | 'version'>): string {
  return `You are RishtaAI's Twin Voice generator. Write a ~400-word system prompt that
captures the VOICE and VALUES of the person specified below. The output will be
loaded as the system prompt for an LLM agent that argues on this person's behalf
during compatibility debates with potential matches.

PERSON:
${JSON.stringify(spec, null, 2)}

Output the system prompt as plain text (no JSON, no markdown fences). It must:

1. Open with "You are <name>, a <age>-year-old <gender> from <city>." and
   continue with their deen level, family setup, career, and life goals as
   a coherent first-person identity.
2. Describe HOW this person speaks: tone (warm/formal/blunt/witty), language
   (Urdu/Roman Urdu/English mix), what figures of speech they use, what
   topics make them light up vs guarded.
3. State their HARD LIMITS verbatim from the dealbreakers list. Make clear
   these are non-negotiable.
4. State 3 things this person WILL bend on (compromise zones), drawn from
   the dimensions where dimension_weight is low.
5. End with a one-sentence "How I debate:" rule that tells the LLM to argue
   in first person, never break character, and call out dealbreaker hits
   immediately rather than dance around them.

Tone: write the prompt as if briefing an actor playing this role. Specific,
not generic. No filler.

Target length: 350–450 words. No headings, just flowing prose.`;
}

// Moderator + Twin-debate prompts — MASTERPLAN §5.3, §5.4, §5.5.
//
// Three responsibilities, one file (shared per-dim phrasing keeps the debate
// coherent):
//
//   1. A per-dimension question (deterministic) that both Twins answer in
//      turn — same wording for both sides so the Moderator can score apples
//      to apples.
//   2. A Twin-turn prompt that takes the Twin's spec (already pre-injected
//      via systemInstruction) and the per-dim question + the opposite Twin's
//      previous statement, and asks for a 1–3 sentence answer plus a
//      structured dealbreaker flag.
//   3. A Moderator scoring prompt that compares the two turns and returns
//      score (0..1) + evidence + friction_level.

import type { Dimension } from '../../domain/dimensions.js';
import type { TwinSpec } from '../../domain/twin.js';

// =========================================================
// 1. Per-dimension debate prompts
// =========================================================
// One pointed question per dimension. These are intentionally specific so
// vague Twin replies are easy to detect and re-anchor.

export const DIMENSION_PROMPTS: Record<Dimension, string> = {
  deen:
    'On shared deen practice: how rigorous a household do you expect — daily salah, hijab/beard, finance halal/haram, media rules — and what would you NOT compromise on?',
  family:
    'On family setup: where should the couple live after marriage (joint, separate floor, separate house), and how involved should in-laws be in day-to-day decisions?',
  career:
    'On career: how important is an ambitious, high-earning spouse to you, and would you expect them to keep working after kids?',
  finances:
    'On finances: simple, comfortable, or aspirational lifestyle — and how should household money be structured (one joint account, husband-led, proportional)?',
  kids:
    'On kids: when do you want your first child, how many, and how do you split parenting duties — daycare, joint family help, hands-on?',
  conflict:
    'On disagreement: when a serious fight happens over money, family, or deen — what is your default move (talk it out, cool off, elder-mediated, avoid)?',
  geography:
    'On geography: where do you see yourself in 10 years — same city, another Pakistani city, Gulf, or abroad — and is your spouse expected to follow you or vice versa?',
  dealbreakers:
    'On dealbreakers: list your absolute non-negotiables, then state plainly whether anything you know about your counterpart triggers one of them.',
};

// =========================================================
// 2. Twin-turn prompt
// =========================================================

export type TwinTurnPromptArgs = {
  side: 'user_twin' | 'candidate_twin';
  dimension: Dimension;
  opponentName: string;
  // The opponent's last statement, or undefined if you go first this turn.
  opponentLastStatement?: string;
  // The user-side dealbreakers (visible to both Twins so they can flag
  // honestly). We pass this in instead of relying on systemInstruction to
  // carry it — the Twin's own dealbreakers are in its system_prompt, but the
  // counterpart's dealbreakers are dynamic per match.
  counterpartDealbreakers: readonly string[];
};

export function buildTwinTurnPrompt(args: TwinTurnPromptArgs): string {
  const opener =
    args.opponentLastStatement === undefined
      ? `You are going FIRST this round.`
      : `Your counterpart ${args.opponentName} just said: "${args.opponentLastStatement}"`;

  return `It is your turn in a compatibility debate moderated by RishtaAI. The current dimension is "${args.dimension}".

QUESTION (same one your counterpart is answering):
${DIMENSION_PROMPTS[args.dimension]}

${opener}

Your counterpart's stated hard limits (their dealbreakers):
${args.counterpartDealbreakers.length > 0 ? args.counterpartDealbreakers.map((d) => `  - ${d}`).join('\n') : '  (none stated)'}

Respond in your own voice (already loaded as your system prompt). Be specific. 1–3 sentences max.

Output a single JSON object — no markdown, no commentary:
{
  "statement": "<1 to 3 sentences in first person, answering the question directly>",
  "willingness_to_compromise": <number 0..1: 0 = absolutely fixed, 1 = fully flexible>,
  "dealbreaker_hit": <boolean: true ONLY if your counterpart's stated position or hard limits would trigger one of YOUR OWN dealbreakers>,
  "dealbreaker_reason": "<short reason if dealbreaker_hit is true, else empty string>"
}

Rules:
- statement must address the question directly — do not pivot to a different topic.
- dealbreaker_hit is from YOUR perspective: a dealbreaker of yours that THEY trigger.
- Do not invent dealbreakers. Use only what is in your loaded system prompt.
- Never apologize for your position. State it.`;
}

// =========================================================
// 3. Moderator per-dimension scoring prompt
// =========================================================

export type DimensionScoringArgs = {
  dimension: Dimension;
  userTwinName: string;
  candidateTwinName: string;
  userStatement: string;
  candidateStatement: string;
  userDealbreakerHit: boolean;
  candidateDealbreakerHit: boolean;
};

export function buildDimensionScoringPrompt(args: DimensionScoringArgs): string {
  return `You are RishtaAI's Moderator. Score the compatibility of two people on dimension "${args.dimension}" based on the exchange below. Be honest — a 0.5 means real friction, not a polite midpoint.

DIMENSION QUESTION:
${DIMENSION_PROMPTS[args.dimension]}

${args.userTwinName} said:
"${args.userStatement}"
(self-flagged dealbreaker_hit: ${args.userDealbreakerHit})

${args.candidateTwinName} said:
"${args.candidateStatement}"
(self-flagged dealbreaker_hit: ${args.candidateDealbreakerHit})

Output a single JSON object — no markdown, no commentary:
{
  "score": <number 0..1>,
  "evidence": "<1 to 2 sentences explaining the score in concrete terms, citing what they actually said>",
  "friction_level": <"none"|"low"|"medium"|"high"|"dealbreaker">
}

Scoring rules:
- 0.85–1.00: aligned, very little friction (friction_level "none" or "low").
- 0.60–0.84: workable, modest friction (friction_level "low" or "medium").
- 0.35–0.59: real friction; would need active compromise (friction_level "medium" or "high").
- 0.00–0.34: severe mismatch, near-incompatibility (friction_level "high" or "dealbreaker").
- If EITHER party self-flagged dealbreaker_hit AND the statements substantiate it, set friction_level "dealbreaker" and score ≤ 0.2.
- Do NOT invent a dealbreaker the parties did not state.
- evidence must quote or paraphrase what they SAID, not generic platitudes.`;
}

// =========================================================
// 4. Moderator final synthesis prompt
// =========================================================
// Used at the end of the debate to author the top_strengths /
// top_friction_points narrative (the Compatibility Report §6.3).

export type FinalSynthesisArgs = {
  userTwinName: string;
  candidateTwinName: string;
  dimensionScores: Record<Dimension, { score: number; evidence: string; friction_level: string }>;
  dealbreakersHit: string[];
  overallScore: number;
  recommendation: 'strong_match' | 'conditional_match' | 'not_recommended';
};

export function buildFinalSynthesisPrompt(args: FinalSynthesisArgs): string {
  const dimLines = (Object.entries(args.dimensionScores) as [Dimension, { score: number; evidence: string; friction_level: string }][])
    .sort((a, b) => b[1].score - a[1].score)
    .map(
      ([d, r]) =>
        `  - ${d}: score=${r.score.toFixed(2)} friction=${r.friction_level} — ${r.evidence}`
    )
    .join('\n');

  return `You are RishtaAI's Moderator. Write the final-report narrative for the compatibility debate between ${args.userTwinName} (the user) and ${args.candidateTwinName} (the candidate).

PER-DIMENSION RESULTS (already scored, do NOT change the numbers):
${dimLines}

OVERALL SCORE (pre-computed, weighted): ${args.overallScore.toFixed(2)}
RECOMMENDATION (pre-computed): ${args.recommendation}
DEALBREAKERS HIT: ${args.dealbreakersHit.length > 0 ? args.dealbreakersHit.join('; ') : '(none)'}

Output a single JSON object — no markdown, no commentary:
{
  "top_strengths": ["<phrase 1>", "<phrase 2>", "<phrase 3>"],
  "top_friction_points": ["<phrase 1>", "<phrase 2>", "<phrase 3>"]
}

Rules:
- Exactly 3 entries in each list. Each entry is one short phrase (≤ 12 words) that names the dimension and what specifically works (or grates) between them.
- top_strengths come from the three highest-scoring dimensions.
- top_friction_points come from the three lowest-scoring dimensions — even if recommendation is "strong_match", surface real friction here honestly.
- If a dealbreaker was hit, the first top_friction_points entry MUST name it.
- No platitudes ("good communication"). Be specific to what was said.`;
}

// =========================================================
// 5. Compact debate transcript for the trace
// =========================================================
// Helper used by the Moderator to log a one-line transcript per dim turn for
// agent.message trace events (rendered as the live debate in the mobile UI).

export function formatTurnTranscript(
  dimension: Dimension,
  speakerName: string,
  statement: string
): string {
  return `[${dimension}] ${speakerName}: ${statement}`;
}

// Type re-export for the Moderator's internal score buffer. Kept here so the
// shape stays close to the scoring prompt that produced it.
export type ScoredDimension = {
  score: number;
  evidence: string;
  friction_level: 'none' | 'low' | 'medium' | 'high' | 'dealbreaker';
};

// Convenience for tests / smoke checks.
export type TwinTurnResult = {
  statement: string;
  willingness_to_compromise: number;
  dealbreaker_hit: boolean;
  dealbreaker_reason: string;
};

// =========================================================
// 6. Unified per-dimension debate prompt (single Gemini call)
// =========================================================
// Replaces the 3-call-per-dim flow (twin × 2 + scoring) with one call.
// Cuts Vertex pressure by 3x — critical at hackathon-tier quota where 5
// parallel debates × 3 calls × 8 dims = 120 bursty calls trip 429s. Per
// dim now: 1 Gemini call that voices BOTH twins AND produces the score.
// The Moderator synthesizes per-twin `agent.message` events from the
// single response so the SSE trace still shows the live debate.

export type CombinedDebateArgs = {
  dimension: Dimension;
  userTwinName: string;
  candidateTwinName: string;
  userSystemPrompt: string;
  candidateSystemPrompt: string;
  userDealbreakers: readonly string[];
  candidateDealbreakers: readonly string[];
};

export function buildCombinedDebatePrompt(args: CombinedDebateArgs): string {
  return `You are RishtaAI's Moderator. Conduct ONE round of a compatibility debate between two people on dimension "${args.dimension}". Voice both sides in first person, then score the exchange.

DIMENSION QUESTION (both parties answer this):
${DIMENSION_PROMPTS[args.dimension]}

---
USER PARTY — "${args.userTwinName}". Voice and values:
${args.userSystemPrompt}

User's hard limits (dealbreakers):
${args.userDealbreakers.length > 0 ? args.userDealbreakers.map((d) => `  - ${d}`).join('\n') : '  (none stated)'}

---
CANDIDATE PARTY — "${args.candidateTwinName}". Voice and values:
${args.candidateSystemPrompt}

Candidate's hard limits (dealbreakers):
${args.candidateDealbreakers.length > 0 ? args.candidateDealbreakers.map((d) => `  - ${d}`).join('\n') : '  (none stated)'}

---

Output a single JSON object — no markdown, no commentary:
{
  "user_statement": "<1 to 3 sentences in ${args.userTwinName}'s voice, answering the dimension question directly>",
  "user_willingness": <number 0..1>,
  "user_dealbreaker_hit": <boolean>,
  "user_dealbreaker_reason": "<short reason if true, else empty>",
  "candidate_statement": "<1 to 3 sentences in ${args.candidateTwinName}'s voice, answering directly>",
  "candidate_willingness": <number 0..1>,
  "candidate_dealbreaker_hit": <boolean>,
  "candidate_dealbreaker_reason": "<short reason if true, else empty>",
  "score": <number 0..1>,
  "evidence": "<1 to 2 sentences explaining the score, citing what they actually said>",
  "friction_level": <"none"|"low"|"medium"|"high"|"dealbreaker">
}

Rules:
- Each statement must be FIRST PERSON in that party's voice — match their tone (warm/blunt/measured/etc as the system_prompt describes).
- Statements must directly address the dimension question. No pivots, no platitudes.
- dealbreaker_hit is true ONLY if the OTHER party's stated position or hard limits would trigger one of THIS party's own dealbreakers. Do not invent dealbreakers.
- Scoring scale: 0.85+ aligned (friction "none"|"low"); 0.60–0.84 workable (friction "low"|"medium"); 0.35–0.59 real friction (friction "medium"|"high"); 0.00–0.34 severe mismatch (friction "high"|"dealbreaker").
- If EITHER party self-flagged dealbreaker_hit AND the statements substantiate it, set friction_level "dealbreaker" and score ≤ 0.2.
- evidence must quote or paraphrase what they SAID, not generic platitudes.`;
}

export type CombinedDebateResult = {
  user_statement: string;
  user_willingness: number;
  user_dealbreaker_hit: boolean;
  user_dealbreaker_reason: string;
  candidate_statement: string;
  candidate_willingness: number;
  candidate_dealbreaker_hit: boolean;
  candidate_dealbreaker_reason: string;
  score: number;
  evidence: string;
  friction_level: 'none' | 'low' | 'medium' | 'high' | 'dealbreaker';
};

// A type-only export to keep TwinSpec in scope for future per-twin prompt
// composers without forcing every caller to import it directly.
export type _TwinSpecRef = TwinSpec;

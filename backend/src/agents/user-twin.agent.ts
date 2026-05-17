// User Twin Agent — MASTERPLAN §5.3.
//
// Represents the USER in compatibility debates. One invocation = one
// dimension-turn. The Twin's voice/values are loaded as Gemini's
// systemInstruction (the ~400-word system_prompt that Twin Forge synthesized
// in Session 2). Per MASTERPLAN: temperature 0.4.
//
// Both user_twin.agent.ts and candidate_twin.agent.ts share the same engine
// (runTwinTurn below) — the only operational difference is the agent name
// stamped on trace events. Splitting into two files matches MASTERPLAN §4
// file layout and keeps the Moderator's call sites self-documenting.

import { z } from 'zod';
import { geminiCall } from './_shared/gemini.js';
import { decide, obs, recover, type TraceBus } from './_shared/trace.js';
import { logger } from '../utils/logger.js';
import {
  buildTwinTurnPrompt,
  formatTurnTranscript,
  type TwinTurnResult,
} from '../content/prompts/moderator.prompt.js';
import type { Dimension } from '../domain/dimensions.js';
import type { TwinSpec } from '../domain/twin.js';

// =========================================================
// Output schema
// =========================================================

const TwinTurnSchema = z.object({
  statement: z.string().min(2).max(1200),
  willingness_to_compromise: z.number().min(0).max(1),
  dealbreaker_hit: z.boolean(),
  dealbreaker_reason: z.string().max(400).default(''),
});

// =========================================================
// Shared engine — used by candidate-twin.agent.ts too.
// =========================================================

export type TwinSide = 'user_twin' | 'candidate_twin';

export type RunTwinTurnArgs = {
  /** Spec for THIS twin — the one being voiced. */
  spec: TwinSpec;
  /** Spec for the OPPONENT — used to expose their dealbreakers honestly. */
  opponentSpec: TwinSpec;
  /** Current debate dimension. */
  dimension: Dimension;
  /** Opponent's last statement this turn, if any. */
  opponentLastStatement?: string;
};

// Gemini 2.5+ models consume token budget for internal "thinking" before any
// visible output. Empirically with PER_TURN_MAX_TOKENS=512 we got 19-char
// responses that failed schema; bumping to 2048 gives thinking + the actual
// JSON (~250 chars) plenty of room. Each twin turn is still a single Gemini
// call so the latency cost is "more thinking is allowed", not "two calls".
const PER_TURN_MAX_TOKENS = 2048;
const PER_TURN_TEMPERATURE = 0.4;

export async function runTwinTurn(
  side: TwinSide,
  args: RunTwinTurnArgs,
  bus: TraceBus
): Promise<TwinTurnResult> {
  const agentName = side;
  const speakerName = args.spec.identity.name;

  obs(
    bus,
    agentName,
    `${speakerName} taking turn on dimension=${args.dimension}; ${
      args.opponentLastStatement ? `responding to ${args.opponentSpec.identity.name}` : 'going first'
    }`
  );

  const prompt = buildTwinTurnPrompt({
    side,
    dimension: args.dimension,
    opponentName: args.opponentSpec.identity.name,
    ...(args.opponentLastStatement !== undefined
      ? { opponentLastStatement: args.opponentLastStatement }
      : {}),
    counterpartDealbreakers: args.opponentSpec.dealbreakers,
  });

  let parsed: TwinTurnResult;
  try {
    const gem = await geminiCall(
      {
        prompt,
        systemInstruction: args.spec.system_prompt,
        temperature: PER_TURN_TEMPERATURE,
        maxOutputTokens: PER_TURN_MAX_TOKENS,
        responseFormat: 'json',
        // Per MASTERPLAN §8.2: "downgrade to Flash for non-Moderator agents"
        // when latency matters. Twin turns are voice-not-judgement, Flash
        // handles them well and we avoid Pro's thinking-token tax + the
        // parallel-rate-limit pressure of 10 simultaneous Pro calls per dim.
        modelTier: 'flash',
      },
      bus
    );
    parsed = TwinTurnSchema.parse(JSON.parse(gem.text));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), side, dim: args.dimension },
      'twin turn: Gemini call or schema parse failed; falling back to deterministic neutral statement'
    );
    recover(
      bus,
      `Twin turn for ${speakerName} on ${args.dimension} failed (LLM or schema)`,
      'returning a deterministic neutral statement derived from the spec so the debate continues'
    );
    parsed = fallbackTurn(args.spec, args.dimension);
  }

  // The Twin's own dealbreaker_hit is sanity-checked against the spec — if
  // the model claims a dealbreaker hit but the opponent's spec doesn't trip
  // anything in OUR dealbreakers list, downgrade to false. Prevents the
  // Moderator from being misled by an over-eager Twin.
  const verified = verifyDealbreakerHit(args.spec, args.opponentSpec, parsed);
  if (verified !== parsed.dealbreaker_hit) {
    recover(
      bus,
      `${speakerName} self-flagged dealbreaker_hit=${parsed.dealbreaker_hit} but no matching string in their spec`,
      'verified=false; downgrading to avoid a false-positive dealbreaker'
    );
    parsed = { ...parsed, dealbreaker_hit: verified, dealbreaker_reason: verified ? parsed.dealbreaker_reason : '' };
  }

  bus.emit({
    type: 'agent.message',
    agent: agentName,
    content: formatTurnTranscript(args.dimension, speakerName, parsed.statement),
    ts: Date.now(),
  });

  decide(
    bus,
    agentName,
    `${speakerName} answered ${args.dimension}: dealbreaker_hit=${parsed.dealbreaker_hit}, willingness=${parsed.willingness_to_compromise.toFixed(2)}`,
    parsed.dealbreaker_hit
      ? `flagged: ${parsed.dealbreaker_reason || 'no reason given'}`
      : 'no dealbreaker triggered'
  );

  return parsed;
}

// =========================================================
// User Twin public entrypoint
// =========================================================

export async function userTwinTurn(args: RunTwinTurnArgs, bus: TraceBus): Promise<TwinTurnResult> {
  return runTwinTurn('user_twin', args, bus);
}

// =========================================================
// Fallback + verification helpers
// =========================================================

function fallbackTurn(spec: TwinSpec, dimension: Dimension): TwinTurnResult {
  // Deterministic, opinionated statement drawn from the structured spec so a
  // failed LLM turn still gives the Moderator something to score on.
  const i = spec.identity;
  const map: Record<Dimension, string> = {
    deen: `Speaking honestly: my deen level is ${spec.deen_level}, and that is how I expect our household to run from day one. I am not going to flex on the basics.`,
    family: `On family — we are a ${spec.family_setup} setup and my loyalty to my family is real. I expect a partner who respects that.`,
    career: `My career is at ${spec.career.current}; in five years I want ${spec.career.five_yr_goal}. A partner needs to be on board with that, not threatened by it.`,
    finances: `I lean ${spec.finances.lifestyle_pref} on lifestyle and ${spec.finances.current_status} on money today. That is what we would be working with.`,
    kids: `Kids: ${kidsHuman(spec.kids_timeline)}. That is not a negotiation point.`,
    conflict: `When we fight, I am ${spec.conflict_style}. That is how I am — and I expect a partner who can meet me there.`,
    geography: `I am in ${spec.geography.current_city} now; in ten years I see myself in ${spec.geography.ten_yr_pref}. ${spec.geography.flexible ? 'I am flexible if the case is good.' : 'I am not moving for someone.'}`,
    dealbreakers: `My hard limits are: ${spec.dealbreakers.length > 0 ? spec.dealbreakers.join('; ') : 'I will name them as they come up.'} These are non-negotiable.`,
  };
  return {
    statement: map[dimension] || `As ${i.name}, my position on ${dimension} is consistent with my spec.`,
    willingness_to_compromise: 0.35,
    dealbreaker_hit: false,
    dealbreaker_reason: '',
  };
}

function kidsHuman(k: TwinSpec['kids_timeline']): string {
  if (k === 'asap') return 'I want kids within the first year';
  if (k === '2-3_yrs') return 'I want kids in two to three years';
  if (k === '5_plus') return 'I want to wait five or more years before kids';
  return 'I am open to not having kids';
}

function verifyDealbreakerHit(
  selfSpec: TwinSpec,
  opponentSpec: TwinSpec,
  turn: TwinTurnResult
): boolean {
  if (!turn.dealbreaker_hit) return false;
  // String-overlap check: at least one of my dealbreakers should mention a
  // token that appears in the opponent's structured spec or system_prompt.
  // This is intentionally permissive — false-positives surface during
  // Moderator scoring, false-negatives only matter if the Twin lied about a
  // hit, which is rare.
  const opponentBlob = [
    opponentSpec.deen_level,
    opponentSpec.family_setup,
    opponentSpec.kids_timeline,
    opponentSpec.conflict_style,
    opponentSpec.finances.current_status,
    opponentSpec.finances.lifestyle_pref,
    opponentSpec.geography.current_city,
    opponentSpec.geography.ten_yr_pref,
    opponentSpec.system_prompt,
    ...opponentSpec.dealbreakers,
  ]
    .join(' ')
    .toLowerCase();

  for (const db of selfSpec.dealbreakers) {
    const tokens = db
      .toLowerCase()
      .split(/[\s,;:.\-/]+/)
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
    if (tokens.some((t) => opponentBlob.includes(t))) return true;
  }
  return false;
}

const STOPWORDS = new Set([
  'must',
  'should',
  'would',
  'have',
  'with',
  'from',
  'this',
  'that',
  'they',
  'them',
  'their',
  'about',
  'after',
  'before',
  'while',
  'into',
  'over',
  'open',
  'open.',
  'spouse',
  'partner',
  'prior',
  'past',
  'wants',
  'want',
  'will',
  'never',
  'always',
  'only',
]);

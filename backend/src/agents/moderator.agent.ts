// Moderator Agent — MASTERPLAN §5.5.
//
// Orchestrates ONE compatibility debate between the user's Twin and one
// candidate Twin. For each of the 8 dimensions:
//   1. The two Twins answer the same dimension question (RUN IN PARALLEL —
//      they answer independently anyway, halves the per-dim latency).
//   2. The Moderator scores the exchange 0..1 with evidence and emits a
//      `dimension.scored` event.
//   3. If either side flagged a dealbreaker hit that the scoring corroborates,
//      the debate short-circuits and the remaining dimensions are filled in
//      as neutral (the verdict is already forced to not_recommended).
//
// After 8 dims, a final-synthesis Gemini call writes the
// top_strengths/top_friction_points narrative. The scoring module
// (`src/domain/scoring.ts`) aggregates everything into the CompatibilityReport.
//
// Latency posture (§9 budget):
//   - Per dim: ~3s (parallel Twin turns ~1.5s + Moderator scoring ~1.5s).
//   - 8 dims sequential = ~24s; +1 final synthesis call = ~26s for one debate.
//   - 5 debates run in parallel from the find_matches workplan; the workplan
//     budget is 30s, so a tight match. If we blow it, the workplan emits a
//     recovery and aggregates with whatever per-dim scores are in.

import { z } from 'zod';
import { geminiCall } from './_shared/gemini.js';
import { decide, obs, recover, taskEnd, taskStart, type TraceBus } from './_shared/trace.js';
import { logger } from '../utils/logger.js';
import { repairTruncatedJson } from '../utils/jsonRepair.js';
import {
  buildCombinedDebatePrompt,
  buildFinalSynthesisPrompt,
  formatTurnTranscript,
  type ScoredDimension,
} from '../content/prompts/moderator.prompt.js';
import { DIMENSIONS, type Dimension } from '../domain/dimensions.js';
import type { TwinSpec } from '../domain/twin.js';
import {
  aggregateReport,
  fallbackHighlights,
  type CompatibilityReport,
  type FrictionLevel,
} from '../domain/scoring.js';

// =========================================================
// Schemas for Gemini-authored responses
// =========================================================

const CombinedDebateSchema = z.object({
  user_statement: z.string().min(2).max(1200),
  user_willingness: z.number().min(0).max(1),
  user_dealbreaker_hit: z.boolean(),
  user_dealbreaker_reason: z.string().max(400).default(''),
  candidate_statement: z.string().min(2).max(1200),
  candidate_willingness: z.number().min(0).max(1),
  candidate_dealbreaker_hit: z.boolean(),
  candidate_dealbreaker_reason: z.string().max(400).default(''),
  score: z.number().min(0).max(1),
  evidence: z.string().min(2).max(800),
  friction_level: z.enum(['none', 'low', 'medium', 'high', 'dealbreaker']),
});

const SynthesisSchema = z.object({
  top_strengths: z.array(z.string().min(1).max(160)).length(3),
  top_friction_points: z.array(z.string().min(1).max(160)).length(3),
});

// =========================================================
// Per-debate budget
// =========================================================
// 26s soft limit per debate. If exceeded mid-loop, remaining dimensions are
// filled in as neutral so the report still ships and the trace records the
// recovery. The workplan's overall 30s budget is enforced by Promise.race in
// the workplan layer (see find-matches.workplan.ts).

// Per-debate budget for the 8-dim loop. 60s gives us comfortable headroom
// under quota — empirically the unified-per-dim flow on Flash runs ~3-4s per
// dim including the global semaphore (cap=3, so 5 parallel debates share the
// slots cooperatively). 8 dims × ~4s = ~32s typical, 60s cap for outliers.
const PER_DEBATE_BUDGET_MS = 60_000;
const DEBATE_TEMPERATURE = 0.4;
// One call per dim now (was three). Output is ~600-800 chars JSON. 2048
// tokens gives generous headroom with Flash thinking off.
const DEBATE_MAX_TOKENS = 2048;
const SYNTHESIS_TEMPERATURE = 0.3;
// Was 1024; observed truncation `Unterminated string in JSON at position 125`
// when Pro's thinking budget ate the visible response. 2048 + jsonRepair tail
// in the catch handler covers both root causes.
const SYNTHESIS_MAX_TOKENS = 2048;

// =========================================================
// Public API
// =========================================================

export type ModeratorInput = {
  userSpec: TwinSpec;
  candidateSpec: TwinSpec;
  candidateId: string;
};

export type ModeratorOutput = {
  candidateId: string;
  report: CompatibilityReport;
  perDimension: Record<Dimension, ScoredDimension>;
  durationMs: number;
  budgetExceeded: boolean;
  dimensionsScored: number;
};

export async function runDebate(
  input: ModeratorInput,
  bus: TraceBus
): Promise<ModeratorOutput> {
  const candidateId = input.candidateId;
  const start = Date.now();
  const userName = input.userSpec.identity.name;
  const candName = input.candidateSpec.identity.name;
  const taskLabel = `debate:${candName}`;
  taskStart(bus, taskLabel);

  obs(bus, 'moderator', `opening debate: ${userName} vs ${candName}`);
  decide(
    bus,
    'moderator',
    `running 8-dimension debate at temperature ${DEBATE_TEMPERATURE}`,
    `user weights: ${formatWeights(input.userSpec.dimension_weights)}; dealbreakers count: user=${input.userSpec.dealbreakers.length}, candidate=${input.candidateSpec.dealbreakers.length}`
  );

  const perDim = {} as Record<Dimension, ScoredDimension>;
  const dealbreakersHit: string[] = [];
  let earlyTerminated = false;
  let budgetExceeded = false;

  for (const dim of DIMENSIONS) {
    const elapsed = Date.now() - start;
    if (elapsed > PER_DEBATE_BUDGET_MS) {
      budgetExceeded = true;
      recover(
        bus,
        `per-debate budget ${PER_DEBATE_BUDGET_MS}ms exceeded (elapsed ${elapsed}ms)`,
        `skipping remaining dimensions (${remainingDims(perDim)}) — they will aggregate as neutral`
      );
      decide(
        bus,
        'moderator',
        'force-terminating debate due to time budget',
        'remaining dimensions filled as neutral 0.5 in the final report'
      );
      break;
    }

    if (earlyTerminated) {
      // Short-circuit after a confirmed dealbreaker: fill remaining dims as
      // neutral so the trace stays well-formed. We still emit dimension.scored
      // for observability.
      perDim[dim] = {
        score: 0.5,
        evidence: 'Skipped after a verified dealbreaker hit earlier in the debate.',
        friction_level: 'medium',
      };
      emitDimScored(bus, dim, perDim[dim]);
      continue;
    }

    const dimResult = await scoreOneDimension({
      dim,
      userSpec: input.userSpec,
      candidateSpec: input.candidateSpec,
      candidateId,
      bus,
    });

    perDim[dim] = {
      score: dimResult.score,
      evidence: dimResult.evidence,
      friction_level: dimResult.friction_level,
    };
    emitDimScored(bus, dim, perDim[dim]);

    if (dimResult.confirmedDealbreaker.length > 0) {
      dealbreakersHit.push(...dimResult.confirmedDealbreaker);
      // After a CONFIRMED dealbreaker (both self-flag AND Moderator score
      // ≤ 0.2 with friction_level dealbreaker), shortcut the rest of the
      // debate. Per MASTERPLAN §10 the recommendation is already forced
      // to not_recommended.
      earlyTerminated = true;
      decide(
        bus,
        'moderator',
        `confirmed dealbreaker(s) on dimension=${dim}: ${dimResult.confirmedDealbreaker.join('; ')}`,
        'short-circuiting remaining dimensions — final verdict will be not_recommended'
      );
    }
  }

  // -------- Final synthesis (top_strengths / top_friction_points) --------
  const synth = await runFinalSynthesis({
    userName,
    candName,
    perDim,
    dealbreakersHit,
    overallScore: weightedSum(input.userSpec.dimension_weights, perDim),
    bus,
  });

  const report = aggregateReport({
    perDimension: perDim,
    userSpec: input.userSpec,
    dealbreakersHit,
    topStrengths: synth.top_strengths,
    topFrictionPoints: synth.top_friction_points,
  });

  const duration = Date.now() - start;
  const dimensionsScored = Object.keys(perDim).length;

  decide(
    bus,
    'moderator',
    `verdict: ${report.recommendation} (overall=${report.overall_score.toFixed(2)})`,
    `${dimensionsScored}/8 dimensions scored in ${duration}ms; dealbreakers_hit=${dealbreakersHit.length}`
  );

  taskEnd(bus, taskLabel, {
    candidate: candName,
    overall_score: report.overall_score,
    recommendation: report.recommendation,
    dealbreakers_hit: dealbreakersHit.length,
    duration_ms: duration,
    dimensions_scored: dimensionsScored,
    budget_exceeded: budgetExceeded,
  });

  return {
    candidateId: input.candidateId,
    report,
    perDimension: perDim,
    durationMs: duration,
    budgetExceeded,
    dimensionsScored,
  };
}

// =========================================================
// Per-dimension scoring
// =========================================================

type ScoreOneInput = {
  dim: Dimension;
  userSpec: TwinSpec;
  candidateSpec: TwinSpec;
  // Stamped onto agent.message events so the chat replay UI can pick this
  // debate's transcript out of the interleaved 5-debate stream.
  candidateId: string;
  bus: TraceBus;
};

type ScoreOneOutput = {
  score: number;
  evidence: string;
  friction_level: FrictionLevel;
  confirmedDealbreaker: string[];
};

async function scoreOneDimension(input: ScoreOneInput): Promise<ScoreOneOutput> {
  const { dim, userSpec, candidateSpec, candidateId, bus } = input;
  const userName = userSpec.identity.name;
  const candName = candidateSpec.identity.name;

  // -------- One Gemini call that voices BOTH twins + scores the exchange --------
  // The old 3-call-per-dim flow (twin × 2 + scoring) tripped Vertex's burst
  // limits under 5 parallel debates. Unified into one call cuts pressure 3x.
  const prompt = buildCombinedDebatePrompt({
    dimension: dim,
    userTwinName: userName,
    candidateTwinName: candName,
    userSystemPrompt: userSpec.system_prompt,
    candidateSystemPrompt: candidateSpec.system_prompt,
    userDealbreakers: userSpec.dealbreakers,
    candidateDealbreakers: candidateSpec.dealbreakers,
  });

  let parsed: z.infer<typeof CombinedDebateSchema> | null = null;
  let rawText = '';
  try {
    const gem = await geminiCall(
      {
        prompt,
        temperature: DEBATE_TEMPERATURE,
        maxOutputTokens: DEBATE_MAX_TOKENS,
        responseFormat: 'json',
        // Session 7 user pref: Pro for richer per-dim debate turns.
        // Each dim is ONE call (unified per-dim flow), so 5 debates × 8 dims
        // = 40 calls per workplan — well within the raised quota.
        modelTier: 'pro',
      },
      bus
    );
    rawText = gem.text;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), dim },
      'moderator: combined debate Gemini call failed'
    );
  }

  if (rawText.length > 0) {
    try {
      parsed = CombinedDebateSchema.parse(JSON.parse(rawText));
    } catch (firstErr) {
      // jsonRepair fallback — Flash truncates less than Pro but still hits
      // it under burst load (5 parallel debates × 8 dims).
      try {
        const repaired = repairTruncatedJson(rawText);
        parsed = CombinedDebateSchema.parse(JSON.parse(repaired));
        recover(
          bus,
          `dim=${dim}: combined-debate JSON truncated`,
          'parsed after closing unterminated string/object — using repaired debate'
        );
      } catch (secondErr) {
        logger.warn(
          {
            firstErr: firstErr instanceof Error ? firstErr.message : String(firstErr),
            secondErr: secondErr instanceof Error ? secondErr.message : String(secondErr),
            dim,
          },
          'moderator: combined debate schema parse failed even after repair'
        );
      }
    }
  }

  if (!parsed) {
    recover(
      bus,
      `dim=${dim}: combined-debate Gemini call failed`,
      'emitting deterministic neutral statements drawn from each spec so the debate continues'
    );
    parsed = neutralCombinedResult(dim, userSpec, candidateSpec);
  }

  // -------- Emit per-twin agent.message events so the SSE trace still shows
  //          a live debate transcript (mobile UI renders these). --------
  obs(bus, 'user_twin', `${userName} answered ${dim} (willingness=${parsed.user_willingness.toFixed(2)})`);
  bus.emit({
    type: 'agent.message',
    agent: 'user_twin',
    content: formatTurnTranscript(dim, userName, parsed.user_statement),
    candidateId,
    ts: Date.now(),
  });

  obs(bus, 'candidate_twin', `${candName} answered ${dim} (willingness=${parsed.candidate_willingness.toFixed(2)})`);
  bus.emit({
    type: 'agent.message',
    agent: 'candidate_twin',
    content: formatTurnTranscript(dim, candName, parsed.candidate_statement),
    candidateId,
    ts: Date.now(),
  });

  // -------- Confirm dealbreakers --------
  // A dealbreaker is "confirmed" when (a) the model self-flagged it for a
  // party AND (b) friction_level is "dealbreaker" or score ≤ 0.2. The
  // belt-and-suspenders check stops a single overly-cautious turn from
  // torpedoing a match on a hallucinated trigger.
  const confirmed: string[] = [];
  const moderatorAgrees = parsed.friction_level === 'dealbreaker' || parsed.score <= 0.2;
  if (parsed.user_dealbreaker_hit && moderatorAgrees) {
    confirmed.push(`${userName}: ${parsed.user_dealbreaker_reason || `on ${dim}`}`);
  }
  if (parsed.candidate_dealbreaker_hit && moderatorAgrees) {
    confirmed.push(`${candName}: ${parsed.candidate_dealbreaker_reason || `on ${dim}`}`);
  }

  return {
    score: parsed.score,
    evidence: parsed.evidence,
    friction_level: parsed.friction_level,
    confirmedDealbreaker: confirmed,
  };
}

// =========================================================
// Deterministic fallback for the unified per-dim call
// =========================================================
// Triggered when the single Gemini call fails (timeout, schema, 429). Both
// statements come from the SAME deterministic-from-spec generator used by
// user-twin.agent.ts's fallbackTurn so the recovery still looks coherent.

function neutralCombinedResult(
  dim: Dimension,
  userSpec: TwinSpec,
  candidateSpec: TwinSpec
): z.infer<typeof CombinedDebateSchema> {
  return {
    user_statement: deterministicStatement(userSpec, dim),
    user_willingness: 0.35,
    user_dealbreaker_hit: false,
    user_dealbreaker_reason: '',
    candidate_statement: deterministicStatement(candidateSpec, dim),
    candidate_willingness: 0.35,
    candidate_dealbreaker_hit: false,
    candidate_dealbreaker_reason: '',
    score: 0.5,
    evidence: 'Live debate call fell back; using deterministic neutral score.',
    friction_level: 'medium',
  };
}

function deterministicStatement(spec: TwinSpec, dim: Dimension): string {
  // Mirrors fallbackTurn in user-twin.agent.ts so the visible fallback voice
  // stays consistent across both code paths. Kept inline (no shared util)
  // because the two files have different recovery semantics around it.
  const map: Record<Dimension, string> = {
    deen: `My deen level is ${spec.deen_level}, and that is how I expect our household to run from day one.`,
    family: `We are a ${spec.family_setup} setup and my loyalty to my family is real — I expect a partner who respects that.`,
    career: `My career sits at ${spec.career.current}; in five years I want ${spec.career.five_yr_goal}. A partner needs to be on board.`,
    finances: `I lean ${spec.finances.lifestyle_pref} on lifestyle and ${spec.finances.current_status} on money today.`,
    kids: `On kids: ${spec.kids_timeline.replace('_', ' ')}. That is not a negotiation point.`,
    conflict: `When we disagree, I am ${spec.conflict_style} — that is how I am.`,
    geography: `I am in ${spec.geography.current_city} today; in ten years I see myself in ${spec.geography.ten_yr_pref}.`,
    dealbreakers: `My hard limits: ${spec.dealbreakers.length > 0 ? spec.dealbreakers.join('; ') : 'I will name them as they come up.'}`,
  };
  return map[dim];
}

// =========================================================
// Final synthesis
// =========================================================

type SynthesisInput = {
  userName: string;
  candName: string;
  perDim: Record<Dimension, ScoredDimension>;
  dealbreakersHit: string[];
  overallScore: number;
  bus: TraceBus;
};

async function runFinalSynthesis(
  input: SynthesisInput
): Promise<{ top_strengths: [string, string, string]; top_friction_points: [string, string, string] }> {
  const overallScore = input.overallScore;
  const recommendation =
    input.dealbreakersHit.length > 0
      ? 'not_recommended'
      : overallScore >= 0.75
        ? 'strong_match'
        : overallScore >= 0.55
          ? 'conditional_match'
          : 'not_recommended';

  const prompt = buildFinalSynthesisPrompt({
    userTwinName: input.userName,
    candidateTwinName: input.candName,
    dimensionScores: input.perDim,
    dealbreakersHit: input.dealbreakersHit,
    overallScore,
    recommendation,
  });

  let parsed: z.infer<typeof SynthesisSchema> | null = null;
  let rawText = '';
  try {
    const gem = await geminiCall(
      {
        prompt,
        temperature: SYNTHESIS_TEMPERATURE,
        maxOutputTokens: SYNTHESIS_MAX_TOKENS,
        responseFormat: 'json',
        // Pro on synthesis — 1 call per debate (5 per workplan total), low
        // call-volume budget. Session 3 ran this on Flash with thinkingBudget=0
        // and the JSON came back truncated 5/5 times, forcing fallbackHighlights.
        // With billing enabled (300 RPM) Pro lands in ~3-4s and produces
        // narrative top_strengths/top_friction_points rather than deterministic
        // dim labels.
        modelTier: 'pro',
      },
      input.bus
    );
    rawText = gem.text;
    parsed = SynthesisSchema.parse(JSON.parse(rawText));
  } catch (firstErr) {
    // Try a JSON-repair pass on the raw text before falling back to the
    // deterministic highlights — most failures here are mid-string truncation
    // and the visible content is still narrative-quality.
    if (rawText.length > 0) {
      try {
        const repaired = repairTruncatedJson(rawText);
        parsed = SynthesisSchema.parse(JSON.parse(repaired));
        recover(
          input.bus,
          'moderator final synthesis truncated by Gemini',
          'parsed after closing unterminated string/array — using repaired narrative'
        );
      } catch (secondErr) {
        logger.warn(
          {
            firstErr: firstErr instanceof Error ? firstErr.message : String(firstErr),
            secondErr: secondErr instanceof Error ? secondErr.message : String(secondErr),
          },
          'moderator: final synthesis failed even after repair'
        );
      }
    } else {
      logger.warn(
        { err: firstErr instanceof Error ? firstErr.message : String(firstErr) },
        'moderator: final synthesis failed; using deterministic highlights'
      );
    }
  }

  if (parsed) {
    return {
      top_strengths: tripleOf(parsed.top_strengths),
      top_friction_points: tripleOf(parsed.top_friction_points),
    };
  }

  recover(
    input.bus,
    'final-synthesis Gemini call failed',
    'using deterministic highlights drawn from the top/bottom 3 scored dimensions'
  );
  const fb = fallbackHighlights(input.perDim);
  return { top_strengths: fb.strengths, top_friction_points: fb.frictions };
}

// =========================================================
// Helpers
// =========================================================

function tripleOf(arr: string[]): [string, string, string] {
  const a = arr[0] ?? '';
  const b = arr[1] ?? '';
  const c = arr[2] ?? '';
  return [a, b, c];
}

function emitDimScored(bus: TraceBus, dim: Dimension, scored: ScoredDimension): void {
  bus.emit({
    type: 'dimension.scored',
    dimension: dim,
    score: scored.score,
    evidence: scored.evidence,
    ts: Date.now(),
  });
}

function remainingDims(perDim: Record<Dimension, ScoredDimension>): string {
  return DIMENSIONS.filter((d) => !(d in perDim)).join(', ');
}

function weightedSum(
  weights: Record<Dimension, number>,
  perDim: Record<Dimension, ScoredDimension>
): number {
  let s = 0;
  let wsum = 0;
  for (const d of DIMENSIONS) {
    const entry = perDim[d];
    const w = weights[d] ?? 0;
    if (entry === undefined) continue;
    s += entry.score * w;
    wsum += w;
  }
  if (wsum === 0) return 0;
  return s / wsum;
}

function formatWeights(w: Record<Dimension, number>): string {
  return (Object.entries(w) as [Dimension, number][])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d, v]) => `${d}=${v.toFixed(2)}`)
    .join(', ');
}

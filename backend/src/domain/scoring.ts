// Compatibility scoring — MASTERPLAN §6.3 + §10.
//
// Pure aggregation of per-dimension Moderator scores into the final
// CompatibilityReport shape. Recommendation rule from §10:
//   - any dealbreaker hit  → not_recommended (regardless of overall_score)
//   - overall_score ≥ 0.75 → strong_match
//   - overall_score ≥ 0.55 → conditional_match
//   - else                 → not_recommended

import { DIMENSIONS, defaultWeights, type Dimension } from './dimensions.js';
import type { TwinSpec } from './twin.js';

export type FrictionLevel = 'none' | 'low' | 'medium' | 'high' | 'dealbreaker';
export type Recommendation = 'strong_match' | 'conditional_match' | 'not_recommended';

export type DimensionScore = {
  score: number; // 0..1
  weight: number; // 0..1, from user's TwinSpec.dimension_weights
  evidence: string;
  friction_level: FrictionLevel;
};

export type CompatibilityReport = {
  overall_score: number;
  dimension_scores: Record<Dimension, DimensionScore>;
  top_strengths: [string, string, string];
  top_friction_points: [string, string, string];
  dealbreakers_hit: string[];
  recommendation: Recommendation;
};

export type AggregateInput = {
  perDimension: Record<
    Dimension,
    { score: number; evidence: string; friction_level: FrictionLevel }
  >;
  userSpec: TwinSpec;
  dealbreakersHit: string[];
  // top_strengths / top_friction_points text — provided by the Moderator's
  // final synthesis prompt. If the synthesis failed, callers can pass a
  // deterministic fallback derived from the per-dim evidence.
  topStrengths: [string, string, string];
  topFrictionPoints: [string, string, string];
};

export function aggregateReport(input: AggregateInput): CompatibilityReport {
  const weights = ensureSumOne(input.userSpec.dimension_weights);

  let overall = 0;
  const dimScores = {} as Record<Dimension, DimensionScore>;

  for (const d of DIMENSIONS) {
    const raw = input.perDimension[d];
    if (!raw) {
      // Missing a dimension is treated as 0.5 with 'medium' friction — this
      // path fires only if the Moderator's debate loop bails before scoring
      // every dim (e.g. time-budget exceeded). aggregateReport itself never
      // throws.
      dimScores[d] = {
        score: 0.5,
        weight: weights[d],
        evidence: 'Not debated this round; treated as neutral.',
        friction_level: 'medium',
      };
    } else {
      dimScores[d] = {
        score: clamp01(raw.score),
        weight: weights[d],
        evidence: raw.evidence,
        friction_level: raw.friction_level,
      };
    }
    overall += dimScores[d].score * dimScores[d].weight;
  }

  overall = clamp01(overall);

  const recommendation = pickRecommendation(overall, input.dealbreakersHit.length > 0);

  return {
    overall_score: round2(overall),
    dimension_scores: dimScores,
    top_strengths: input.topStrengths,
    top_friction_points: input.topFrictionPoints,
    dealbreakers_hit: input.dealbreakersHit,
    recommendation,
  };
}

// =========================================================
// Helpers
// =========================================================

function pickRecommendation(overall: number, hadDealbreaker: boolean): Recommendation {
  if (hadDealbreaker) return 'not_recommended';
  if (overall >= 0.75) return 'strong_match';
  if (overall >= 0.55) return 'conditional_match';
  return 'not_recommended';
}

function ensureSumOne(w: Record<Dimension, number>): Record<Dimension, number> {
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (sum === 0) return defaultWeights();
  if (Math.abs(sum - 1) < 0.01) return w;
  const out = {} as Record<Dimension, number>;
  for (const d of DIMENSIONS) out[d] = w[d] / sum;
  return out;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// =========================================================
// Deterministic fallback for top_strengths / top_friction_points
// =========================================================
// Used when the Moderator's final-synthesis prompt fails. Picks the 3
// highest- and 3 lowest-scoring dimensions and produces short phrases from
// their evidence strings.

export function fallbackHighlights(
  perDimension: Record<Dimension, { score: number; evidence: string; friction_level: FrictionLevel }>
): { strengths: [string, string, string]; frictions: [string, string, string] } {
  const sorted = (Object.entries(perDimension) as [Dimension, { score: number; evidence: string }][])
    .sort((a, b) => b[1].score - a[1].score);

  const pickPhrase = (entry: [Dimension, { score: number; evidence: string }] | undefined): string => {
    if (!entry) return 'No data';
    const [dim, r] = entry;
    const shortened = r.evidence.split(/[.!?]/, 1)[0]?.trim() ?? '';
    return `${dim}: ${shortened || `score ${r.score.toFixed(2)}`}`;
  };

  return {
    strengths: [pickPhrase(sorted[0]), pickPhrase(sorted[1]), pickPhrase(sorted[2])],
    frictions: [
      pickPhrase(sorted[sorted.length - 1]),
      pickPhrase(sorted[sorted.length - 2]),
      pickPhrase(sorted[sorted.length - 3]),
    ],
  };
}

// =========================================================
// Baseline (non-agentic) scorer — required deliverable §11 Day 3.
// =========================================================
// Same TwinSpec features as the prescreen, but produces an end-to-end score
// without any LLM debate. Used by GET /baseline/match to demonstrate the
// agentic uplift in the demo.

import { _internals as prescreenInternals } from './prescreen.js';

export function baselineScore(user: TwinSpec, candidate: TwinSpec): number {
  const u = prescreenInternals.vectorize(prescreenInternals.featurize(user));
  const c = prescreenInternals.vectorize(prescreenInternals.featurize(candidate));
  const sim = prescreenInternals.cosine(u, c);
  const pen = prescreenInternals.dealbreakerPenalty(user, candidate);
  return clamp01(sim - pen);
}

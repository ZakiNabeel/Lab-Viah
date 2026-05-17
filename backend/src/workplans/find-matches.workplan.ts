// find_matches workplan — MASTERPLAN §8.2.
//
// Triggered by POST /match/request. One trace per call. Steps:
//   1. load_user_twin            — fetch the user's current TwinSpec from `twins`.
//   2. prescreen_candidates      — load 12 candidate twins, score-and-cut to 5
//                                  (cosine on a hand-built 18-dim feature space
//                                  + dealbreaker overlap penalty).
//   3. parallel debates          — spawn 5 Moderator.runDebate calls
//                                  concurrently. Each has its own self-budget
//                                  (26s in moderator.agent.ts); the workplan
//                                  enforces a master 35s hard ceiling here.
//   4. rank_reports              — sort by overall_score, take top 3.
//   5. persist_reports + notify  — write 5 compatibility_reports rows (all
//                                  debated candidates, not just top-3, so
//                                  the user can drill in), end the trace.
//
// The workplan runs async — POST /match/request returns the flowId
// immediately. The SSE endpoint /stream/:flowId carries live trace events;
// GET /match/results/:flowId fetches persisted reports once the trace closes.

import { randomUUID } from 'node:crypto';
import {
  decide,
  endTrace,
  obs,
  recover,
  startTrace,
  taskEnd,
  taskStart,
  type TraceBus,
} from '../agents/_shared/trace.js';
import { runDebate, type ModeratorOutput } from '../agents/moderator.agent.js';
import { CANDIDATES } from '../content/candidates.js';
import { dbRead, dbWrite, supabase } from '../db/client.js';
import { prescreen, type PrescreenedCandidate } from '../domain/prescreen.js';
import {
  baselineScore,
  type CompatibilityReport,
  type Recommendation,
} from '../domain/scoring.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { Dimension } from '../domain/dimensions.js';
import type { TwinSpec } from '../domain/twin.js';

// =========================================================
// Budgets
// =========================================================

// 90s — above the Moderator's 60s per-debate self-budget. With the unified
// per-dim call (1 Gemini call/dim instead of 3) + concurrency cap=3, a clean
// 5-debate workplan lands ~30-45s. 90s is the safety net for outlier 429
// retries through the wrapper's exponential backoff.
const WORKPLAN_BUDGET_MS = 90_000;

// =========================================================
// Public types
// =========================================================

export type FindMatchesInput = {
  userId: string;
  /** Optional explicit flowId. Default: `match_<uuid>`. */
  flowId?: string;
};

export type MatchSummary = {
  candidateId: string;
  candidateName: string;
  overallScore: number;
  recommendation: Recommendation;
  dealbreakersHit: string[];
};

export type FindMatchesOutput = {
  flowId: string;
  userTwinId: string;
  topThree: MatchSummary[];
  allDebated: MatchSummary[];
  totalCandidates: number;
  prescreenCount: number;
  durationMs: number;
  budgetExceeded: boolean;
};

// =========================================================
// Workplan entry — synchronous "kickoff" that returns flowId + the running
// promise. The route handler awaits flowId but does NOT await the promise
// (lets the workplan run async while the client subscribes to SSE).
// =========================================================

export function startFindMatches(opts: FindMatchesInput): {
  flowId: string;
  promise: Promise<FindMatchesOutput>;
} {
  const flowId = opts.flowId ?? `match_${randomUUID()}`;
  const bus = startTrace('find_matches', { flowId, userId: opts.userId });
  obs(bus, 'workplan', `find_matches kickoff for user=${opts.userId}`);

  const promise = runWorkplan({ ...opts, flowId }, bus).catch(async (err) => {
    // Surface anything that escaped the per-task catches. Close the trace
    // with the error outcome so the SSE consumer sees a finished workplan.
    logger.error(
      { err: err instanceof Error ? err.message : String(err), flowId },
      'find_matches: top-level workplan threw'
    );
    recover(
      bus,
      'workplan-level exception escaped per-task handlers',
      'closing trace with error outcome; client will see workplan.finished with ok=false'
    );
    await endTrace(bus, { error: err instanceof Error ? err.message : String(err) });
    throw err instanceof AppError
      ? err
      : new AppError(
          'INTERNAL',
          `find_matches workplan failed: ${err instanceof Error ? err.message : String(err)}`
        );
  });

  return { flowId, promise };
}

// =========================================================
// Workplan body
// =========================================================

async function runWorkplan(
  opts: { userId: string; flowId: string },
  bus: TraceBus
): Promise<FindMatchesOutput> {
  const start = Date.now();

  // -------- Step 1: load user twin --------
  taskStart(bus, 'load_user_twin');
  const userTwin = await loadUserTwin(opts.userId);
  obs(
    bus,
    'workplan',
    `loaded user twin ${userTwin.id} (${userTwin.spec.identity.name}, ${userTwin.spec.identity.gender}, ${userTwin.spec.identity.city})`
  );
  taskEnd(bus, 'load_user_twin', { twinId: userTwin.id });

  // -------- Step 2: prescreen --------
  taskStart(bus, 'prescreen_candidates');
  const candidatePool = await loadCandidatePool(bus);
  const prescreened = prescreen({
    user: userTwin.spec,
    candidates: candidatePool,
    k: 5,
  });

  if (prescreened.length === 0) {
    taskEnd(bus, 'prescreen_candidates', { error: 'no_eligible_candidates' });
    decide(
      bus,
      'workplan',
      'aborting — no eligible candidates after gender filter',
      `userGender=${userTwin.spec.identity.gender}, pool size=${candidatePool.length}`
    );
    await endTrace(bus, { error: 'no_eligible_candidates' });
    throw new AppError('NOT_FOUND', 'No eligible candidate twins for this user');
  }

  decide(
    bus,
    'workplan',
    `prescreened ${candidatePool.length} → ${prescreened.length} candidates`,
    `top candidate: ${prescreened[0]?.spec.identity.name} (similarity=${prescreened[0]?.similarity.toFixed(3)}, penalty=${prescreened[0]?.dealbreakerPenalty.toFixed(2)})`
  );
  taskEnd(bus, 'prescreen_candidates', {
    selected: prescreened.length,
    pool: candidatePool.length,
    candidates: prescreened.map((p) => ({
      id: p.id,
      name: p.spec.identity.name,
      similarity: round3(p.similarity),
      penalty: round3(p.dealbreakerPenalty),
    })),
  });

  // -------- Step 3: parallel debates --------
  taskStart(bus, 'parallel_debates');
  const settled = await Promise.allSettled(
    prescreened.map((cand) => runDebateWithRetry(userTwin.spec, cand, bus))
  );

  const debates: ModeratorOutput[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]!;
    const cand = prescreened[i]!;
    if (r.status === 'fulfilled') {
      debates.push(r.value);
    } else {
      logger.error(
        { err: r.reason, candidate: cand.spec.identity.name },
        'find_matches: debate rejected even after retry'
      );
      recover(
        bus,
        `debate for ${cand.spec.identity.name} rejected after retry`,
        'synthesizing low-confidence placeholder report so the rank step does not lose the slot'
      );
      debates.push(syntheticFailedDebate(cand, r.reason));
    }
  }
  taskEnd(bus, 'parallel_debates', {
    debates: debates.length,
    durations: debates.map((d) => ({ candidate: d.report.dimension_scores ? '(scored)' : '(failed)', ms: d.durationMs })),
  });

  // -------- Step 4: rank --------
  taskStart(bus, 'rank_reports');
  const ranked = [...debates].sort((a, b) => b.report.overall_score - a.report.overall_score);
  const topThree = ranked.slice(0, 3);
  decide(
    bus,
    'workplan',
    `ranked ${ranked.length} debated candidates`,
    `top three: ${topThree.map((r) => `${candidateNameFor(r, prescreened)} (${r.report.overall_score.toFixed(2)})`).join(', ')}`
  );
  taskEnd(bus, 'rank_reports', {
    topThree: topThree.map((d) => ({
      candidateId: d.candidateId,
      score: d.report.overall_score,
      recommendation: d.report.recommendation,
    })),
  });

  // -------- Step 5: persist --------
  taskStart(bus, 'persist_reports');
  const persistedCount = await persistReports({
    flowId: opts.flowId,
    userTwinId: userTwin.id,
    debates,
    prescreened,
  });
  taskEnd(bus, 'persist_reports', { rows: persistedCount });

  // -------- Done --------
  const elapsed = Date.now() - start;
  const budgetExceeded = elapsed > WORKPLAN_BUDGET_MS;
  if (budgetExceeded) {
    recover(
      bus,
      `workplan elapsed ${elapsed}ms exceeded budget ${WORKPLAN_BUDGET_MS}ms`,
      'reports already persisted; flagging budget_exceeded=true in outcome for downstream visibility'
    );
  }

  const summary = (m: ModeratorOutput): MatchSummary => ({
    candidateId: m.candidateId,
    candidateName: candidateNameFor(m, prescreened),
    overallScore: m.report.overall_score,
    recommendation: m.report.recommendation,
    dealbreakersHit: m.report.dealbreakers_hit,
  });

  const outcome: FindMatchesOutput = {
    flowId: opts.flowId,
    userTwinId: userTwin.id,
    topThree: topThree.map(summary),
    allDebated: ranked.map(summary),
    totalCandidates: candidatePool.length,
    prescreenCount: prescreened.length,
    durationMs: elapsed,
    budgetExceeded,
  };

  await endTrace(bus, outcome);
  return outcome;
}

// =========================================================
// Step 1 helpers — load user twin
// =========================================================

type UserTwinRow = { id: string; spec: TwinSpec };

async function loadUserTwin(userId: string): Promise<UserTwinRow> {
  // Most-recent twin for this user where is_candidate=false. There should be
  // exactly one per Session 2's contract; sort by created_at desc as a safety
  // net if a future Twin v2 update lands.
  type Row = { id: string; spec: TwinSpec };
  const rows = await dbRead<Row[]>('select.twin_by_user', async (sb) => {
    const r = await sb
      .from('twins')
      .select('id, spec')
      .eq('user_id', userId)
      .eq('is_candidate', false)
      .order('created_at', { ascending: false })
      .limit(1);
    return r as { data: Row[] | null; error: { message: string } | null };
  });
  const first = Array.isArray(rows) ? rows[0] : undefined;
  if (!first) {
    throw new AppError('NOT_FOUND', `No Twin v1 found for user ${userId} — finalize onboarding first`);
  }
  return first;
}

// =========================================================
// Step 2 helpers — load candidate pool (DB or content fallback)
// =========================================================

async function loadCandidatePool(
  bus: TraceBus
): Promise<{ id: string; spec: TwinSpec }[]> {
  try {
    type Row = { id: string; spec: TwinSpec };
    const rows = await dbRead<Row[]>('select.candidate_twins', async (sb) => {
      const r = await sb.from('twins').select('id, spec').eq('is_candidate', true).limit(50);
      return r as { data: Row[] | null; error: { message: string } | null };
    });
    if (Array.isArray(rows) && rows.length >= 6) {
      obs(bus, 'workplan', `loaded ${rows.length} candidate twins from DB`);
      return rows;
    }
    recover(
      bus,
      `candidate pool from DB has only ${Array.isArray(rows) ? rows.length : 0} rows`,
      'falling back to in-content CANDIDATES seed (12 personas) — run `npm run seed` to populate DB'
    );
    return [...CANDIDATES.map((c) => ({ id: c.id, spec: c.spec }))];
  } catch (err) {
    recover(
      bus,
      `candidate pool DB read failed: ${err instanceof Error ? err.message : String(err)}`,
      'falling back to in-content CANDIDATES seed (12 personas)'
    );
    return [...CANDIDATES.map((c) => ({ id: c.id, spec: c.spec }))];
  }
}

// =========================================================
// Step 3 helpers — debate with one retry
// =========================================================

async function runDebateWithRetry(
  userSpec: TwinSpec,
  cand: PrescreenedCandidate,
  bus: TraceBus
): Promise<ModeratorOutput> {
  try {
    return await runDebate(
      { userSpec, candidateSpec: cand.spec, candidateId: cand.id },
      bus
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), candidate: cand.spec.identity.name },
      'debate first attempt threw; retrying once'
    );
    recover(
      bus,
      `debate for ${cand.spec.identity.name} threw on first attempt`,
      'retrying once before marking as low-confidence'
    );
    return runDebate(
      { userSpec, candidateSpec: cand.spec, candidateId: cand.id },
      bus
    );
  }
}

function syntheticFailedDebate(cand: PrescreenedCandidate, reason: unknown): ModeratorOutput {
  // Used only when BOTH the original debate AND the retry rejected. Produces
  // a placeholder report so the rank step doesn't lose the candidate
  // entirely. The recommendation is 'not_recommended' because we can't
  // vouch for compatibility on no evidence.
  const reasonStr = reason instanceof Error ? reason.message : String(reason);
  const perDim = {} as Record<Dimension, { score: number; weight: number; evidence: string; friction_level: 'medium' }>;
  for (const d of ['deen', 'family', 'career', 'finances', 'kids', 'conflict', 'geography', 'dealbreakers'] as const) {
    perDim[d] = {
      score: 0.5,
      weight: cand.spec.dimension_weights[d] ?? 0.125,
      evidence: 'Debate failed; could not score this dimension.',
      friction_level: 'medium',
    };
  }
  const report: CompatibilityReport = {
    overall_score: 0.0,
    dimension_scores: perDim,
    top_strengths: ['(no debate)', '(no debate)', '(no debate)'],
    top_friction_points: [
      `Debate failed: ${reasonStr.slice(0, 80)}`,
      '(no debate)',
      '(no debate)',
    ],
    dealbreakers_hit: [],
    recommendation: 'not_recommended',
  };
  return {
    candidateId: cand.id,
    report,
    perDimension: perDim as unknown as ModeratorOutput['perDimension'],
    durationMs: 0,
    budgetExceeded: false,
    dimensionsScored: 0,
  };
}

// =========================================================
// Step 5 helpers — persist
// =========================================================

type PersistArgs = {
  flowId: string;
  userTwinId: string;
  debates: ModeratorOutput[];
  prescreened: PrescreenedCandidate[];
};

async function persistReports(args: PersistArgs): Promise<number> {
  const rows = args.debates.map((d) => {
    const pre = args.prescreened.find((p) => p.id === d.candidateId);
    return {
      user_twin_id: args.userTwinId,
      candidate_twin_id: d.candidateId,
      overall_score: d.report.overall_score,
      dimension_scores: d.report.dimension_scores,
      top_strengths: d.report.top_strengths,
      top_friction_points: d.report.top_friction_points,
      dealbreakers_hit: d.report.dealbreakers_hit,
      recommendation: d.report.recommendation,
      reasoning_trace: {
        flow_id: args.flowId,
        candidate_name: pre?.spec.identity.name ?? '(unknown)',
        prescreen_similarity: pre?.similarity ?? null,
        prescreen_penalty: pre?.dealbreakerPenalty ?? null,
        duration_ms: d.durationMs,
        budget_exceeded: d.budgetExceeded,
        dimensions_scored: d.dimensionsScored,
      },
      flow_id: args.flowId,
    };
  });

  type Row = { id: string };
  const inserted = await dbWrite<Row[]>('insert.compatibility_reports', async (sb) => {
    const r = await sb.from('compatibility_reports').insert(rows).select('id');
    return r as { data: Row[] | null; error: { message: string } | null };
  });
  return Array.isArray(inserted) ? inserted.length : 0;
}

// =========================================================
// Misc
// =========================================================

function candidateNameFor(
  m: ModeratorOutput,
  prescreened: readonly PrescreenedCandidate[]
): string {
  return prescreened.find((p) => p.id === m.candidateId)?.spec.identity.name ?? '(unknown)';
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// =========================================================
// Baseline (non-agentic) ranker — required deliverable per MASTERPLAN §11 Day 3.
// Same TwinSpec inputs, simple weighted-distance, no debate, no Gemini.
// Lives here (next to the agentic workplan) for side-by-side audit.
// =========================================================

export type BaselineRanking = {
  userTwinId: string;
  ranking: {
    candidateId: string;
    candidateName: string;
    baselineScore: number;
  }[];
};

export async function runBaseline(userId: string): Promise<BaselineRanking> {
  const userTwin = await loadUserTwin(userId);
  // Same pool the agentic flow would use, minus the trace-bus plumbing.
  let pool: { id: string; spec: TwinSpec }[];
  try {
    type Row = { id: string; spec: TwinSpec };
    const rows = await dbRead<Row[]>('select.candidate_twins', async (sb) => {
      const r = await sb.from('twins').select('id, spec').eq('is_candidate', true).limit(50);
      return r as { data: Row[] | null; error: { message: string } | null };
    });
    pool = Array.isArray(rows) && rows.length >= 6
      ? rows
      : [...CANDIDATES.map((c) => ({ id: c.id, spec: c.spec }))];
  } catch {
    pool = [...CANDIDATES.map((c) => ({ id: c.id, spec: c.spec }))];
  }
  const opposite = userTwin.spec.identity.gender === 'male' ? 'female' : 'male';
  const ranked = pool
    .filter((c) => c.spec.identity.gender === opposite)
    .map((c) => ({
      candidateId: c.id,
      candidateName: c.spec.identity.name,
      baselineScore: round3(baselineScore(userTwin.spec, c.spec)),
    }))
    .sort((a, b) => b.baselineScore - a.baselineScore);

  return { userTwinId: userTwin.id, ranking: ranked };
}

// =========================================================
// Results fetcher — used by GET /match/results/:flowId
// =========================================================

export type StoredReportRow = {
  candidate_twin_id: string;
  overall_score: number;
  dimension_scores: CompatibilityReport['dimension_scores'];
  top_strengths: string[];
  top_friction_points: string[];
  dealbreakers_hit: string[];
  recommendation: Recommendation;
  reasoning_trace: { candidate_name?: string; [k: string]: unknown };
  generated_at: string;
};

export async function fetchReportsForFlow(flowId: string): Promise<StoredReportRow[]> {
  type Row = StoredReportRow;
  const rows = await dbRead<Row[]>('select.reports_by_flow', async (sb) => {
    const r = await sb
      .from('compatibility_reports')
      .select(
        'candidate_twin_id, overall_score, dimension_scores, top_strengths, top_friction_points, dealbreakers_hit, recommendation, reasoning_trace, generated_at'
      )
      .eq('flow_id', flowId)
      .order('overall_score', { ascending: false });
    return r as { data: Row[] | null; error: { message: string } | null };
  });
  return Array.isArray(rows) ? rows : [];
}

// Keep `supabase` import alive for future direct-query helpers in this file.
void supabase;

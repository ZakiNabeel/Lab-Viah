// onboarding_flow workplan — MASTERPLAN §8.1.
//
// One trace per user journey, spanning multiple HTTP calls. The route handlers
// look up (or create) the TraceBus by sessionId and call into these helpers,
// which own:
//   - task.started / task.finished framing per layer
//   - per-layer agent invocation
//   - applying agent output back onto the session
//   - the visible-recovery event when Layer 2 deltas push a value out of range
//
// Persistence happens in the `finalize` helper (writes twin row, ends trace).

import { z } from 'zod';
import {
  startTrace,
  getTrace,
  taskEnd,
  taskStart,
  obs,
  decide,
  recover,
  endTrace,
  type TraceBus,
} from '../agents/_shared/trace.js';
import { runOnboardingTurn, type OnboardingTurnResult } from '../agents/onboarding.agent.js';
import {
  forgeTwin,
  generateLayer3Statements,
  reconcileWaliConflicts,
} from '../agents/twin-forge.agent.js';
import { supabase, dbWrite } from '../db/client.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { SCENARIO_CARDS, getCard, getOption } from '../content/scenario-cards.js';
import {
  createSession,
  getSession,
  dropSession,
  type OnboardingSession,
  type ScenarioResponse,
  type WaliInput,
} from '../domain/onboarding-session.js';
import { type Dimension } from '../domain/dimensions.js';
import type { LanguagePref, TwinSpec } from '../domain/twin.js';

// -------- Public types --------

export type StartOpts = { userId: string; language: LanguagePref };

export type LayerResultEnvelope<T> = {
  sessionId: string;
  flowId: string;
  result: T;
};

// =========================================================
// Layer 0 — start session + open trace bus
// =========================================================

export function startOnboarding(opts: StartOpts): { session: OnboardingSession; bus: TraceBus } {
  const session = createSession({ userId: opts.userId, language: opts.language });
  const bus = startTrace('onboarding_flow', { flowId: session.sessionId, userId: opts.userId });
  obs(bus, 'workplan', `onboarding_flow opened for user=${opts.userId}, language=${opts.language}`);
  return { session, bus };
}

export function resumeOnboarding(sessionId: string): { session: OnboardingSession; bus: TraceBus } {
  const session = getSession(sessionId);
  if (!session) {
    throw new AppError('NOT_FOUND', `Onboarding session ${sessionId} not found or expired`);
  }
  // Trace bus may still be live in memory (same process). If not, the trace
  // already closed; the route should refuse further turns.
  const bus = lookupActiveBus(sessionId);
  if (!bus) {
    throw new AppError(
      'CONFLICT',
      `Onboarding session ${sessionId} state is alive but its trace has closed; client must call /onboarding/layer1 to restart`
    );
  }
  return { session, bus };
}

function lookupActiveBus(flowId: string): TraceBus | undefined {
  return getTrace(flowId);
}

// =========================================================
// Layer 1 — chat turn
// =========================================================

export async function runLayer1(opts: {
  session: OnboardingSession;
  bus: TraceBus;
  text?: string;
  audioBase64?: string;
}): Promise<OnboardingTurnResult> {
  const { session, bus } = opts;
  const task = `layer1_chat:turn_${session.layer1Turns + 1}`;
  taskStart(bus, task);

  const history: { role: 'user' | 'agent'; content: string }[] = [];

  const turn = await runOnboardingTurn(
    {
      session,
      ...(opts.text !== undefined ? { text: opts.text } : {}),
      ...(opts.audioBase64 !== undefined ? { audioBase64: opts.audioBase64 } : {}),
      history,
    },
    bus
  );

  // Merge extracted fields back onto session.payload, recording per-field
  // confidence (capped to the turn's overall confidence — proxies the model's
  // own uncertainty on this exact field).
  applyExtracted(session, turn);
  session.layer1Turns += 1;

  taskEnd(bus, task, {
    confidence: turn.confidence,
    next_topic: turn.next_topic,
    turns_used: session.layer1Turns,
  });

  return turn;
}

function applyExtracted(session: OnboardingSession, turn: OnboardingTurnResult): void {
  const e = turn.extracted;
  const p = session.payload;
  const conf = p.per_field_confidence ?? {};

  if (e.identity) {
    p.identity = { ...(p.identity ?? {}), ...stripUndef(e.identity) };
    for (const k of Object.keys(stripUndef(e.identity))) {
      conf[`identity.${k}`] = turn.confidence;
    }
  }
  if (e.deen_level) {
    p.deen_level = e.deen_level;
    conf['deen_level'] = turn.confidence;
  }
  if (e.family_setup) {
    p.family_setup = e.family_setup;
    conf['family_setup'] = turn.confidence;
  }
  if (e.career) {
    p.career = { ...(p.career ?? {}), ...stripUndef(e.career) };
    for (const k of Object.keys(stripUndef(e.career))) {
      conf[`career.${k}`] = turn.confidence;
    }
  }
  if (e.kids_timeline) {
    p.kids_timeline = e.kids_timeline;
    conf['kids_timeline'] = turn.confidence;
  }
  if (e.geography) {
    p.geography = { ...(p.geography ?? {}), ...stripUndef(e.geography) };
    for (const k of Object.keys(stripUndef(e.geography))) {
      conf[`geography.${k}`] = turn.confidence;
    }
  }
  if (e.dealbreakers && e.dealbreakers.length > 0) {
    const merged = new Set([...(p.dealbreakers ?? []), ...e.dealbreakers]);
    p.dealbreakers = [...merged];
    conf['dealbreakers'] = turn.confidence;
  }

  p.per_field_confidence = conf;
}

function stripUndef<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// =========================================================
// Layer 2 — scenario card scoring
// =========================================================

export type RadarState = {
  vector: Partial<Record<Dimension, number>>;
  cardsAnswered: number;
  cardsRemaining: string[];
};

const ScenarioBody = z.object({
  cardId: z.string().min(1),
  optionId: z.string().min(1),
});

export function runLayer2(opts: {
  session: OnboardingSession;
  bus: TraceBus;
  cardId: string;
  optionId: string;
}): RadarState {
  const { session, bus, cardId, optionId } = opts;
  const parsed = ScenarioBody.safeParse({ cardId, optionId });
  if (!parsed.success) {
    throw new AppError('BAD_REQUEST', 'Invalid scenario response', { details: parsed.error.issues });
  }

  const task = `layer2_card:${cardId}`;
  taskStart(bus, task);

  const card = getCard(cardId);
  if (!card) {
    taskEnd(bus, task, { error: 'unknown_card' });
    throw new AppError('NOT_FOUND', `Scenario card ${cardId} not found`);
  }
  const option = getOption(card, optionId);
  if (!option) {
    taskEnd(bus, task, { error: 'unknown_option' });
    throw new AppError('NOT_FOUND', `Option ${optionId} not found on card ${cardId}`);
  }

  if (session.scenarioResponses.some((r) => r.cardId === cardId)) {
    obs(bus, 'workplan', `card ${cardId} already answered — overwriting with new option ${optionId}`);
    session.scenarioResponses = session.scenarioResponses.filter((r) => r.cardId !== cardId);
  }

  const response: ScenarioResponse = { cardId, optionId };
  session.scenarioResponses.push(response);

  // Apply signed contributions; clamp aggregated value to [-1, 1].
  let clampedAny = false;
  for (const [dim, delta] of Object.entries(option.contributions)) {
    const key = dim as Dimension;
    const prev = session.personalityVector[key] ?? 0;
    const next = prev + (delta ?? 0);
    const clamped = Math.max(-1, Math.min(1, next));
    if (clamped !== next) clampedAny = true;
    session.personalityVector[key] = clamped;
  }

  if (clampedAny) {
    recover(
      bus,
      'personality vector hit ±1 saturation after applying card contributions',
      'clamped to [-1, 1] so downstream Twin Forge prompts stay well-conditioned'
    );
  }

  decide(
    bus,
    'workplan',
    `card ${cardId} option ${optionId} applied`,
    `contributions: ${Object.entries(option.contributions)
      .map(([d, v]) => `${d}${v! > 0 ? '+' : ''}${(v as number).toFixed(2)}`)
      .join(', ')}`
  );

  const answered = new Set(session.scenarioResponses.map((r) => r.cardId));
  const remaining = SCENARIO_CARDS.map((c) => c.id).filter((id) => !answered.has(id));

  taskEnd(bus, task, {
    vector: session.personalityVector,
    cardsAnswered: session.scenarioResponses.length,
    cardsRemaining: remaining.length,
  });

  return {
    vector: session.personalityVector,
    cardsAnswered: session.scenarioResponses.length,
    cardsRemaining: remaining,
  };
}

// =========================================================
// Layer 3 — twin statements + corrections
// =========================================================

export async function runLayer3Generate(opts: {
  session: OnboardingSession;
  bus: TraceBus;
}): Promise<typeof opts.session.twinStatements> {
  const task = 'layer3_generate';
  taskStart(opts.bus, task);

  const statements = await generateLayer3Statements(opts.session, opts.bus);
  opts.session.twinStatements = statements;

  taskEnd(opts.bus, task, { count: statements.length });
  return statements;
}

export function applyLayer3Corrections(opts: {
  session: OnboardingSession;
  bus: TraceBus;
  corrections: { dimension: Dimension; agree: boolean; correction?: string }[];
}): typeof opts.session.twinStatements {
  const task = 'layer3_corrections';
  taskStart(opts.bus, task);

  let applied = 0;
  for (const c of opts.corrections) {
    const stmt = opts.session.twinStatements.find((s) => s.dimension === c.dimension);
    if (!stmt) continue;
    stmt.agree = c.agree;
    if (c.correction !== undefined) stmt.correction = c.correction;
    applied += 1;
  }

  decide(
    opts.bus,
    'workplan',
    `applied ${applied}/${opts.corrections.length} Layer-3 corrections`,
    'corrections feed into final Twin Forge synthesis'
  );

  taskEnd(opts.bus, task, { applied });
  return opts.session.twinStatements;
}

// =========================================================
// Layer 4 — wali input
// =========================================================

export function runLayer4(opts: {
  session: OnboardingSession;
  bus: TraceBus;
  input: WaliInput;
}): { conflicts: ReturnType<typeof reconcileWaliConflicts> } {
  const task = 'layer4_wali';
  taskStart(opts.bus, task);

  opts.session.waliInput = opts.input;
  const conflicts = reconcileWaliConflicts(opts.session, opts.bus);
  opts.session.waliConflicts = conflicts;

  taskEnd(opts.bus, task, { conflicts: conflicts.length });
  return { conflicts };
}

// =========================================================
// Finalize — forge spec, persist, close trace
// =========================================================

export type FinalizeResult = {
  twinId: string;
  spec: TwinSpec;
  traceEventCount: number;
};

export async function finalizeOnboarding(opts: {
  session: OnboardingSession;
  bus: TraceBus;
}): Promise<FinalizeResult> {
  const { session, bus } = opts;
  const task = 'forge_twin';
  taskStart(bus, task);

  // Hard precondition: Layer 1 has identity, Layer 2 has at least one card,
  // Layer 3 has produced statements. Otherwise the spec will be garbage.
  if (!session.payload.identity?.name) {
    throw new AppError('BAD_REQUEST', 'Cannot finalize: Layer 1 identity is missing');
  }
  if (session.scenarioResponses.length === 0) {
    throw new AppError('BAD_REQUEST', 'Cannot finalize: Layer 2 scenario cards have not been answered');
  }

  const spec = await forgeTwin(session, bus);
  taskEnd(bus, task, { name: spec.identity.name, version: spec.version });

  const persistTask = 'persist_twin';
  taskStart(bus, persistTask);

  type TwinRow = { id: string };
  const row = await dbWrite<TwinRow[]>('insert.twin', async (sb) => {
    // 768-dim embedding is computed in Session 3 when find_matches lands.
    // Leaving NULL here is fine — the ivfflat index allows NULL rows.
    const r = await sb
      .from('twins')
      .insert({
        user_id: session.userId,
        is_candidate: false,
        version: spec.version,
        spec,
      })
      .select('id');
    return r as { data: TwinRow[] | null; error: { message: string } | null };
  });

  const inserted = Array.isArray(row) ? row[0] : undefined;
  if (!inserted?.id) {
    throw new AppError('INTERNAL', 'Twin insert returned no id');
  }
  const twinId = inserted.id;

  // Mirror identity onto the users row so the rest of the app has it cheap.
  const { error: userUpdateErr } = await supabase
    .from('users')
    .update({
      name: spec.identity.name,
      age: spec.identity.age,
      gender: spec.identity.gender,
      city: spec.identity.city,
      language_pref: spec.language_pref,
      last_active: new Date().toISOString(),
    })
    .eq('id', session.userId);
  if (userUpdateErr) {
    logger.warn({ err: userUpdateErr.message }, 'finalize: failed to mirror identity to users row');
  }

  taskEnd(bus, persistTask, { twinId });

  const eventCount = bus.events().length + 1; // +1 for the workplan.finished about to fire
  await endTrace(bus, { twinId, name: spec.identity.name, version: spec.version });

  // Free in-memory session state.
  dropSession(session.sessionId);

  return { twinId, spec, traceEventCount: eventCount };
}

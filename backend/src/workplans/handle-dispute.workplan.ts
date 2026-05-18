// handle_dispute workplan — MASTERPLAN §8.4.
//
// Synchronous (awaited by the route): 1-2 Gemini calls + a DB write keeps
// total wall-clock well under 3s. A trace is opened so the flow is auditable
// via /stream/:flowId even though the SSE stream ends quickly.
//
// Steps per §8.4:
//   1. collect_perspectives  — load meeting row + both Twin specs.
//   2. classify_severity     — Dispute Agent calls Gemini Pro, emits ruling.
//   3. apply_reputation      — extract reputation deltas from resolution.
//   4. flag_for_human_review — emitted as decide + recover if escalated.
//   5. notify_both_parties   — mock SMS via smsRender for filed + resolved.
//   6. persist_dispute       — insert disputes row with full resolution jsonb.

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
import { runDisputeAgent, type DisputeResolution, type DisputeType } from '../agents/dispute.agent.js';
import { smsRender } from '../tools/sms.template.js';
import { dbRead, dbWrite } from '../db/client.js';
import { CANDIDATES } from '../content/candidates.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { actionLabel, severityLabel } from '../content/prompts/dispute.prompt.js';
import type { TwinSpec } from '../domain/twin.js';

// =========================================================
// Public types
// =========================================================

export type HandleDisputeInput = {
  userId: string;
  meetingId: string;
  filedBy: 'user' | 'wali';
  type: DisputeType;
  narrative: string;
  counterPartyNarrative?: string;
  flowId?: string;
};

export type HandleDisputeOutcome = {
  flowId: string;
  disputeId: string;
  resolution: DisputeResolution;
};

// =========================================================
// Entry point — synchronous from the route's perspective
// =========================================================

export async function handleDispute(input: HandleDisputeInput): Promise<HandleDisputeOutcome> {
  const flowId = input.flowId ?? `dispute_${randomUUID()}`;
  const bus = startTrace('handle_dispute', { flowId, userId: input.userId });
  obs(bus, 'workplan', `handle_dispute kickoff: meetingId=${input.meetingId} type=${input.type} filedBy=${input.filedBy}`);

  try {
    const outcome = await runDisputeWorkplan(input, flowId, bus);
    await endTrace(bus, outcome);
    return outcome;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), flowId },
      'handle_dispute: workplan threw'
    );
    recover(bus, 'workplan-level exception escaped per-task handlers', 'closing trace with error outcome');
    await endTrace(bus, { error: err instanceof Error ? err.message : String(err) });
    throw err instanceof AppError
      ? err
      : new AppError('INTERNAL', `handle_dispute failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// =========================================================
// Workplan body
// =========================================================

async function runDisputeWorkplan(
  input: HandleDisputeInput,
  flowId: string,
  bus: TraceBus
): Promise<HandleDisputeOutcome> {

  // -------- Step 1: collect_perspectives --------
  taskStart(bus, 'collect_perspectives');
  const ctx = await loadDisputeContext(input.userId, input.meetingId);
  obs(
    bus,
    'workplan',
    `loaded meeting ${input.meetingId}: filer=${ctx.filerSpec.identity.name}, counterparty=${ctx.counterpartySpec.identity.name}`
  );
  taskEnd(bus, 'collect_perspectives', {
    meetingId: input.meetingId,
    filerTwinId: ctx.filerTwinId,
    counterpartyTwinId: ctx.counterpartyTwinId,
  });

  // -------- Step 2: classify_severity via Dispute Agent --------
  taskStart(bus, 'classify_severity');
  const { resolution, fromFallback } = await runDisputeAgent(
    {
      disputeType: input.type,
      filedBy: input.filedBy,
      narrative: input.narrative,
      counterPartyNarrative: input.counterPartyNarrative,
      filerSpec: ctx.filerSpec,
      counterpartySpec: ctx.counterpartySpec,
    },
    bus
  );
  taskEnd(bus, 'classify_severity', {
    severity: resolution.severity,
    action: resolution.action,
    escalated: resolution.escalated,
    fromFallback,
  });

  // -------- Step 3: apply_reputation_impact --------
  taskStart(bus, 'apply_reputation_impact');
  obs(
    bus,
    'workplan',
    `reputation deltas: ${resolution.reputation_impact.map((r) => `${r.party}:${r.delta}`).join(', ') || 'none'}`
  );
  decide(
    bus,
    'workplan',
    `reputation impact applied: ${resolution.reputation_impact.length} entries`,
    `severity=${resolution.severity} label=${severityLabel(resolution.severity)}`
  );
  taskEnd(bus, 'apply_reputation_impact', { entries: resolution.reputation_impact.length });

  // Step 4: flag_for_human_review — already emitted inside the Dispute Agent
  // (both decide + recover events). No additional workplan-level event needed.

  // -------- Step 5: notify_both_parties --------
  taskStart(bus, 'notify_both_parties');
  const filerName = ctx.filerSpec.identity.name;
  const counterpartyName = ctx.counterpartySpec.identity.name;
  const sevLabel = severityLabel(resolution.severity);
  const actLabel = actionLabel(resolution.action);

  // Render "dispute_filed" to the filer and "dispute_resolved" to both parties.
  await Promise.all([
    smsRender(
      {
        template: 'dispute_filed',
        toRole: 'user',
        toPhone: '+10000000001', // mock — no real phone in dispute context
        toName: filerName,
        language: 'en',
        vars: {
          userName: filerName,
          candidateName: counterpartyName,
          disputeType: input.type,
        },
      },
      bus
    ),
    smsRender(
      {
        template: 'dispute_resolved',
        toRole: 'user',
        toPhone: '+10000000001',
        toName: filerName,
        language: 'en',
        vars: {
          userName: filerName,
          candidateName: counterpartyName,
          severityLabel: sevLabel,
          actionLabel: actLabel,
        },
      },
      bus
    ),
    smsRender(
      {
        template: 'dispute_resolved',
        toRole: 'candidate',
        toPhone: '+10000000002',
        toName: '(counterparty)',
        language: 'en',
        vars: {
          userName: filerName,
          candidateName: counterpartyName,
          severityLabel: sevLabel,
          actionLabel: actLabel,
        },
      },
      bus
    ),
  ]);
  taskEnd(bus, 'notify_both_parties', { smsCount: 3 });

  // -------- Step 6: persist_dispute --------
  taskStart(bus, 'persist_dispute');
  const disputeId = await insertDisputeRow({
    meetingId: input.meetingId,
    filedBy: input.filedBy,
    type: input.type,
    resolution,
  });
  taskEnd(bus, 'persist_dispute', { disputeId });

  decide(
    bus,
    'workplan',
    `handle_dispute complete: dispute ${disputeId} status=resolved, action=${resolution.action}`,
    `severity=${resolution.severity} (${sevLabel}), escalated=${resolution.escalated}, sms=3 rendered (mocked)`
  );

  return { flowId, disputeId, resolution };
}

// =========================================================
// Step 1 helpers — load context
// =========================================================

type DisputeContext = {
  filerTwinId: string;
  counterpartyTwinId: string;
  filerSpec: TwinSpec;
  counterpartySpec: TwinSpec;
};

type MeetingRow = {
  id: string;
  user_id: string;
  candidate_id: string;
  status: string;
};

async function loadDisputeContext(userId: string, meetingId: string): Promise<DisputeContext> {
  // Load the meeting row — verify it exists and belongs to this user.
  const rows = await dbRead<MeetingRow[]>('select.meeting_for_dispute', async (sb) => {
    const r = await sb
      .from('meetings')
      .select('id, user_id, candidate_id, status')
      .eq('id', meetingId)
      .limit(1);
    return r as { data: MeetingRow[] | null; error: { message: string } | null };
  });
  const meeting = Array.isArray(rows) ? rows[0] : undefined;
  if (!meeting) {
    throw new AppError('NOT_FOUND', `meeting ${meetingId} not found`);
  }
  if (meeting.user_id !== userId) {
    throw new AppError('FORBIDDEN', `meeting ${meetingId} does not belong to this user`);
  }

  // Load filer's Twin spec (the user who filed).
  type TwinRow = { id: string; spec: TwinSpec };
  const userTwinRows = await dbRead<TwinRow[]>('select.user_twin_for_dispute', async (sb) => {
    const r = await sb
      .from('twins')
      .select('id, spec')
      .eq('user_id', userId)
      .eq('is_candidate', false)
      .order('created_at', { ascending: false })
      .limit(1);
    return r as { data: TwinRow[] | null; error: { message: string } | null };
  });
  const userTwin = Array.isArray(userTwinRows) ? userTwinRows[0] : undefined;
  if (!userTwin) {
    throw new AppError('NOT_FOUND', `No Twin found for user ${userId}`);
  }

  // Load counterparty Twin spec — DB first, fallback to in-content seed.
  const candidateTwinId = meeting.candidate_id;
  let counterpartySpec: TwinSpec | undefined;
  try {
    type Row = { id: string; spec: TwinSpec };
    const candidateRows = await dbRead<Row[]>('select.candidate_twin_for_dispute', async (sb) => {
      const r = await sb.from('twins').select('id, spec').eq('id', candidateTwinId).limit(1);
      return r as { data: Row[] | null; error: { message: string } | null };
    });
    counterpartySpec = Array.isArray(candidateRows) ? candidateRows[0]?.spec : undefined;
  } catch (err) {
    logger.warn({ err, candidateTwinId }, 'counterparty twin DB read failed; trying in-content seed');
  }
  if (!counterpartySpec) {
    const seed = CANDIDATES.find((c) => c.id === candidateTwinId);
    if (!seed) {
      throw new AppError('NOT_FOUND', `No candidate twin found with id ${candidateTwinId}`);
    }
    counterpartySpec = seed.spec;
  }

  return {
    filerTwinId: userTwin.id,
    counterpartyTwinId: candidateTwinId,
    filerSpec: userTwin.spec,
    counterpartySpec,
  };
}

// =========================================================
// Step 6 helpers — persist dispute row
// =========================================================

async function insertDisputeRow(args: {
  meetingId: string;
  filedBy: 'user' | 'wali';
  type: DisputeType;
  resolution: DisputeResolution;
}): Promise<string> {
  type InsertRow = { id: string };
  const inserted = await dbWrite<InsertRow[]>('insert.dispute', async (sb) => {
    const r = await sb
      .from('disputes')
      .insert({
        meeting_id: args.meetingId,
        filed_by: args.filedBy,
        type: args.type,
        severity: args.resolution.severity,
        status: 'resolved',
        resolution: args.resolution as unknown as Record<string, unknown>,
        reputation_impact: args.resolution.reputation_impact as unknown as Record<string, unknown>[],
      })
      .select('id');
    return r as { data: InsertRow[] | null; error: { message: string } | null };
  });
  const firstId = Array.isArray(inserted) ? inserted[0]?.id : undefined;
  if (!firstId) {
    throw new AppError('INTERNAL', 'disputes insert returned no id');
  }
  return firstId;
}

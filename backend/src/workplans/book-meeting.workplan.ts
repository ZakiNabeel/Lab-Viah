// book_meeting workplan — MASTERPLAN §8.3.
//
// Two phases, two HTTP calls:
//
//   POST /book/initiate  →  startBookMeeting()
//     1. load_context        — user Twin + candidate Twin + latest report.
//     2. wali_brief          — Wali Agent (EN + native), TTS audio, mock SMS.
//     3. mock_sms_to_both    — render SMS to candidate-side wali too.
//     4. propose_slots       — Booking Agent (3 slot+venue proposals).
//     5. persist_proposal    — meetings row with status='proposed'.
//
//   POST /book/confirm   →  confirmBookMeeting()
//     6. load_meeting        — verify the meeting belongs to this user.
//     7. finalize_meeting    — Booking Agent locks the chosen pair, schedules
//                              reminders.
//     8. persist_confirmed   — meetings row status='confirmed' + locked slot
//                              + locked venue + reminders + meeting card URL.
//     9. notify              — mock SMS confirmation to both walis.
//
// Async/sync split: initiate runs async (returns flowId, client subscribes to
// SSE). confirm runs sync — it's a quick lock-and-persist with no LLM calls,
// so we just return the final meeting payload directly.

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
import { runWaliBrief, type WaliBriefOutput, type WaliRelation } from '../agents/wali.agent.js';
import {
  proposeSlots,
  finalizeMeeting,
  type ProposeSlotsOutput,
  type SlotProposal,
  type FinalizeMeetingOutput,
} from '../agents/booking.agent.js';
import { smsRender, type SmsRenderResult } from '../tools/sms.template.js';
import { dbRead, dbWrite } from '../db/client.js';
import { CANDIDATES } from '../content/candidates.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { TwinSpec } from '../domain/twin.js';
import type { CompatibilityReport, Recommendation } from '../domain/scoring.js';
import type { Dimension } from '../domain/dimensions.js';

// =========================================================
// Public types
// =========================================================

export type StartBookMeetingInput = {
  userId: string;
  candidateTwinId: string;
  userWaliName: string;
  userWaliRelation: WaliRelation;
  userWaliPhone: string;
  candidateWaliName: string;
  candidateWaliPhone: string;
  area?: string;
  flowId?: string;
};

export type BookMeetingInitiateOutcome = {
  flowId: string;
  meetingId: string;
  candidateName: string;
  proposal: ProposeSlotsOutput;
  waliBrief: WaliBriefOutput;
  candidateWaliSms: SmsRenderResult[]; // EN + native (2 entries).
  durationMs: number;
};

export type ConfirmBookMeetingInput = {
  userId: string;
  meetingId: string;
  slotIndex: number;
};

export type BookMeetingConfirmOutcome = {
  meetingId: string;
  flowId: string;
  finalized: FinalizeMeetingOutput;
  confirmationSms: SmsRenderResult[]; // 2 entries: user's wali + candidate's wali in user's native language.
};

// =========================================================
// Phase 1 — initiate
// =========================================================

export function startBookMeeting(input: StartBookMeetingInput): {
  flowId: string;
  meetingIdPromise: Promise<string>;
  promise: Promise<BookMeetingInitiateOutcome>;
} {
  const flowId = input.flowId ?? `book_${randomUUID()}`;
  const bus = startTrace('book_meeting', { flowId, userId: input.userId });
  obs(bus, 'workplan', `book_meeting kickoff for user=${input.userId} candidate=${input.candidateTwinId}`);

  // We resolve meetingIdPromise as soon as the row is inserted so the route
  // handler can return it alongside flowId. The full outcome is the workplan's
  // settled promise.
  let resolveMeetingId!: (id: string) => void;
  let rejectMeetingId!: (err: unknown) => void;
  const meetingIdPromise = new Promise<string>((resolve, reject) => {
    resolveMeetingId = resolve;
    rejectMeetingId = reject;
  });

  const promise = runInitiateWorkplan(input, flowId, bus, resolveMeetingId).catch(async (err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), flowId },
      'book_meeting: initiate workplan threw'
    );
    recover(
      bus,
      'workplan-level exception escaped per-task handlers',
      'closing trace with error outcome'
    );
    rejectMeetingId(err);
    await endTrace(bus, { error: err instanceof Error ? err.message : String(err) });
    throw err instanceof AppError
      ? err
      : new AppError('INTERNAL', `book_meeting failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  return { flowId, meetingIdPromise, promise };
}

async function runInitiateWorkplan(
  input: StartBookMeetingInput,
  flowId: string,
  bus: TraceBus,
  resolveMeetingId: (id: string) => void
): Promise<BookMeetingInitiateOutcome> {
  const start = Date.now();

  // -------- Step 1: load context --------
  taskStart(bus, 'load_context');
  const ctx = await loadBookingContext(input.userId, input.candidateTwinId);
  obs(
    bus,
    'workplan',
    `loaded user=${ctx.userSpec.identity.name} candidate=${ctx.candidateSpec.identity.name} report.overall=${ctx.report.overall_score.toFixed(2)} ${ctx.report.recommendation}`
  );
  taskEnd(bus, 'load_context', {
    userTwinId: ctx.userTwinId,
    candidateTwinId: ctx.candidateTwinId,
    overallScore: ctx.report.overall_score,
    recommendation: ctx.report.recommendation,
  });

  // -------- Step 2 + 3: wali brief + cross-wali SMS in parallel --------
  // Wali Agent generates EN + native brief docs, TTS audio, AND the user-side
  // wali SMS. We render the candidate-side wali SMS separately so step 2 and
  // step 3 of §8.3 stay independently auditable in the trace.
  taskStart(bus, 'wali_brief');
  const briefPromise = runWaliBrief(
    {
      userFirstName: ctx.userSpec.identity.name,
      userSpec: ctx.userSpec,
      candidateSpec: ctx.candidateSpec,
      report: ctx.report,
      userWaliName: input.userWaliName,
      userWaliRelation: input.userWaliRelation,
      userWaliPhone: input.userWaliPhone,
      candidateWaliName: input.candidateWaliName,
      candidateWaliPhone: input.candidateWaliPhone,
      nativeLanguage: ctx.userSpec.language_pref === 'en' ? 'ro_ur' : ctx.userSpec.language_pref,
    },
    bus
  );
  const candidateSmsPromise = Promise.all([
    smsRender(
      {
        template: 'wali_brief_intro',
        toRole: 'wali_candidate',
        toPhone: input.candidateWaliPhone,
        toName: input.candidateWaliName,
        language: 'en',
        vars: candidateWaliVars(ctx, input),
      },
      bus
    ),
    smsRender(
      {
        template: 'wali_brief_intro',
        toRole: 'wali_candidate',
        toPhone: input.candidateWaliPhone,
        toName: input.candidateWaliName,
        language: ctx.userSpec.language_pref === 'en' ? 'ro_ur' : ctx.userSpec.language_pref,
        vars: candidateWaliVars(ctx, input),
      },
      bus
    ),
  ]);
  const [waliBrief, candidateWaliSms] = await Promise.all([briefPromise, candidateSmsPromise]);
  taskEnd(bus, 'wali_brief', {
    languages: waliBrief.briefs.map((b) => b.language),
    audio_ok: waliBrief.briefs.map((b) => !b.audio.textOnly),
    candidateSmsRendered: candidateWaliSms.length,
  });

  // -------- Step 4: propose slots + venues --------
  // Run in the Booking Agent — it pulls calendarMock + mapsFindVenue in
  // parallel under its own task label.
  const proposal = await proposeSlots(
    {
      userSpec: ctx.userSpec,
      candidateSpec: ctx.candidateSpec,
      userWaliPhone: input.userWaliPhone,
      candidateWaliPhone: input.candidateWaliPhone,
      ...(input.area !== undefined ? { area: input.area } : {}),
    },
    bus
  );

  // -------- Step 5: persist proposed meeting --------
  taskStart(bus, 'persist_proposal');
  const meetingId = await insertProposedMeeting({
    userId: input.userId,
    candidateTwinId: ctx.candidateTwinId,
    proposal,
    waliBrief,
    candidateWaliSms,
    flowId,
    userWaliPhone: input.userWaliPhone,
    userWaliName: input.userWaliName,
    candidateWaliPhone: input.candidateWaliPhone,
    candidateWaliName: input.candidateWaliName,
    userFirstName: ctx.userSpec.identity.name,
    candidateName: ctx.candidateSpec.identity.name,
  });
  resolveMeetingId(meetingId);
  taskEnd(bus, 'persist_proposal', {
    meetingId,
    proposalCount: proposal.proposals.length,
  });

  decide(
    bus,
    'workplan',
    `book_meeting initiate complete: meeting ${meetingId} in 'proposed' state`,
    `${proposal.proposals.length} (slot, venue) proposals; wali brief in ${waliBrief.briefs.map((b) => b.language).join(' + ')}; awaiting /book/confirm`
  );

  const outcome: BookMeetingInitiateOutcome = {
    flowId,
    meetingId,
    candidateName: ctx.candidateSpec.identity.name,
    proposal,
    waliBrief,
    candidateWaliSms,
    durationMs: Date.now() - start,
  };

  await endTrace(bus, outcome);
  return outcome;
}

// =========================================================
// Phase 2 — confirm
// =========================================================

export async function confirmBookMeeting(
  input: ConfirmBookMeetingInput
): Promise<BookMeetingConfirmOutcome> {
  // Confirm is fast (no LLM); we open a short trace for auditability.
  const flowId = `book_confirm_${randomUUID()}`;
  const bus = startTrace('book_meeting', { flowId, userId: input.userId });
  obs(bus, 'workplan', `book_meeting confirm for meeting=${input.meetingId} slotIndex=${input.slotIndex}`);

  try {
    // -------- Step 6: load + verify ownership --------
    taskStart(bus, 'load_meeting');
    const row = await loadMeetingRow(input.meetingId);
    if (row.user_id !== input.userId) {
      throw new AppError('FORBIDDEN', `meeting ${input.meetingId} does not belong to this user`);
    }
    if (row.status !== 'proposed') {
      throw new AppError('CONFLICT', `meeting ${input.meetingId} is already ${row.status}`);
    }
    const proposals = row.venue.proposed;
    const chosen = proposals[input.slotIndex];
    if (!chosen) {
      throw new AppError('BAD_REQUEST', `slotIndex ${input.slotIndex} out of range (have ${proposals.length})`);
    }
    taskEnd(bus, 'load_meeting', { meetingId: input.meetingId, chosenIndex: input.slotIndex });

    // -------- Step 7: finalize --------
    const finalized = await finalizeMeeting(
      {
        meetingId: input.meetingId,
        chosen,
        userFirstName: row.venue.context.userFirstName,
        candidateName: row.venue.context.candidateName,
      },
      bus
    );

    // -------- Step 8: persist confirmed --------
    taskStart(bus, 'persist_confirmed');
    await updateMeetingToConfirmed({
      meetingId: input.meetingId,
      finalized,
      proposals,
    });
    taskEnd(bus, 'persist_confirmed', {
      meetingId: input.meetingId,
      slotIso: finalized.slotIso,
      venueName: finalized.venue.name,
    });

    // -------- Step 9: notify (mock confirmation SMS) --------
    taskStart(bus, 'notify');
    const sms = await Promise.all([
      smsRender(
        {
          template: 'meeting_confirmed',
          toRole: 'wali_user',
          toPhone: row.wali_contacts.user.phone,
          toName: row.wali_contacts.user.name,
          language: row.venue.context.language,
          vars: {
            userName: row.venue.context.userFirstName,
            candidateName: row.venue.context.candidateName,
            venueName: finalized.venue.name,
            slotHuman: finalized.slotHuman,
          },
        },
        bus
      ),
      smsRender(
        {
          template: 'meeting_confirmed',
          toRole: 'wali_candidate',
          toPhone: row.wali_contacts.candidate.phone,
          toName: row.wali_contacts.candidate.name,
          language: row.venue.context.language,
          vars: {
            userName: row.venue.context.userFirstName,
            candidateName: row.venue.context.candidateName,
            venueName: finalized.venue.name,
            slotHuman: finalized.slotHuman,
          },
        },
        bus
      ),
    ]);
    taskEnd(bus, 'notify', { smsCount: sms.length });

    decide(
      bus,
      'workplan',
      `meeting ${input.meetingId} confirmed for ${finalized.slotHuman}`,
      `venue locked: ${finalized.venue.name}; ${finalized.reminders.length} reminders scheduled; 2 confirmation SMS rendered`
    );

    const outcome: BookMeetingConfirmOutcome = {
      meetingId: input.meetingId,
      flowId,
      finalized,
      confirmationSms: sms,
    };
    await endTrace(bus, outcome);
    return outcome;
  } catch (err) {
    recover(bus, 'confirm path threw', `closing trace with error outcome: ${err instanceof Error ? err.message : String(err)}`);
    await endTrace(bus, { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// =========================================================
// Step 1 helpers — load context
// =========================================================

type BookingContext = {
  userTwinId: string;
  candidateTwinId: string;
  userSpec: TwinSpec;
  candidateSpec: TwinSpec;
  report: CompatibilityReport;
};

async function loadBookingContext(userId: string, candidateTwinId: string): Promise<BookingContext> {
  // User twin (most recent v1+).
  type TwinRow = { id: string; spec: TwinSpec };
  const userTwinRows = await dbRead<TwinRow[]>('select.user_twin_for_booking', async (sb) => {
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
    throw new AppError('NOT_FOUND', `No Twin v1 found for user ${userId} — finalize onboarding first`);
  }

  // Candidate twin — DB first, fallback to in-content seed (find_matches uses
  // the same pattern).
  let candidateSpec: TwinSpec | undefined;
  try {
    type Row = { id: string; spec: TwinSpec };
    const rows = await dbRead<Row[]>('select.candidate_twin_for_booking', async (sb) => {
      const r = await sb.from('twins').select('id, spec').eq('id', candidateTwinId).limit(1);
      return r as { data: Row[] | null; error: { message: string } | null };
    });
    candidateSpec = Array.isArray(rows) ? rows[0]?.spec : undefined;
  } catch (err) {
    logger.warn({ err, candidateTwinId }, 'candidate twin DB read failed; trying in-content seed');
  }
  if (!candidateSpec) {
    const seed = CANDIDATES.find((c) => c.id === candidateTwinId);
    if (!seed) {
      throw new AppError('NOT_FOUND', `No candidate twin found with id ${candidateTwinId}`);
    }
    candidateSpec = seed.spec;
  }

  // Most recent compatibility_report for this (user_twin, candidate_twin) pair.
  type ReportRow = {
    overall_score: number;
    dimension_scores: Record<Dimension, { score: number; weight: number; evidence: string; friction_level: 'none'|'low'|'medium'|'high'|'dealbreaker' }>;
    top_strengths: string[];
    top_friction_points: string[];
    dealbreakers_hit: string[];
    recommendation: Recommendation;
  };
  let report: CompatibilityReport;
  try {
    const reportRows = await dbRead<ReportRow[]>('select.report_for_pair', async (sb) => {
      const r = await sb
        .from('compatibility_reports')
        .select(
          'overall_score, dimension_scores, top_strengths, top_friction_points, dealbreakers_hit, recommendation'
        )
        .eq('user_twin_id', userTwin.id)
        .eq('candidate_twin_id', candidateTwinId)
        .order('generated_at', { ascending: false })
        .limit(1);
      return r as { data: ReportRow[] | null; error: { message: string } | null };
    });
    const first = Array.isArray(reportRows) ? reportRows[0] : undefined;
    if (!first) {
      throw new AppError('NOT_FOUND', 'no compatibility_report found for this pair — run /match/request first');
    }
    report = {
      overall_score: first.overall_score,
      dimension_scores: first.dimension_scores,
      top_strengths: tripleStr(first.top_strengths),
      top_friction_points: tripleStr(first.top_friction_points),
      dealbreakers_hit: first.dealbreakers_hit,
      recommendation: first.recommendation,
    };
  } catch (err) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') throw err;
    throw new AppError('UPSTREAM_FAILURE', `failed to load compatibility_report: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    userTwinId: userTwin.id,
    candidateTwinId,
    userSpec: userTwin.spec,
    candidateSpec,
    report,
  };
}

function tripleStr(arr: string[] | null | undefined): [string, string, string] {
  const a = arr?.[0] ?? '';
  const b = arr?.[1] ?? '';
  const c = arr?.[2] ?? '';
  return [a, b, c];
}

// =========================================================
// Step 3 helpers — candidate-wali SMS vars
// =========================================================

function candidateWaliVars(ctx: BookingContext, _input: StartBookMeetingInput): Record<string, string | number> {
  return {
    userName: ctx.userSpec.identity.name,
    userAge: ctx.userSpec.identity.age,
    userCity: ctx.userSpec.identity.city,
    candidateName: ctx.candidateSpec.identity.name,
    candidateAge: ctx.candidateSpec.identity.age,
    candidateCity: ctx.candidateSpec.identity.city,
    compatibilityPct: Math.round(ctx.report.overall_score * 100),
  };
}

// =========================================================
// Step 5 helpers — persist proposed meeting
// =========================================================

type ProposedVenueJson = {
  proposed: SlotProposal[];
  chosen: null;
  proposalGeneratedAt: string;
  briefs: {
    language: string;
    document: unknown;
    audioPresent: boolean;
    audioVoiceUsed: string | null;
    audioBytes: number;
    walisSms: { body: string; segments: number; language: string };
    spokenText: string;
    briefFromFallback: boolean;
  }[];
  candidateWaliSms: { body: string; segments: number; language: string }[];
  context: {
    userFirstName: string;
    candidateName: string;
    language: 'en' | 'ur' | 'ro_ur';
    city: string;
    area: string;
  };
};

async function insertProposedMeeting(args: {
  userId: string;
  candidateTwinId: string;
  proposal: ProposeSlotsOutput;
  waliBrief: WaliBriefOutput;
  candidateWaliSms: SmsRenderResult[];
  flowId: string;
  userWaliPhone: string;
  userWaliName: string;
  candidateWaliPhone: string;
  candidateWaliName: string;
  userFirstName: string;
  candidateName: string;
}): Promise<string> {
  const native = args.waliBrief.briefs.find((b) => b.language !== 'en');
  const language = (native ?? args.waliBrief.briefs[0])?.language ?? 'en';
  const venueJson: ProposedVenueJson = {
    proposed: args.proposal.proposals,
    chosen: null,
    proposalGeneratedAt: args.proposal.generatedAt,
    briefs: args.waliBrief.briefs.map((b) => ({
      language: b.language,
      document: b.document,
      audioPresent: !b.audio.textOnly,
      audioVoiceUsed: b.audio.voiceUsed,
      audioBytes: b.audio.audioBytes,
      walisSms: { body: b.walisSms.body, segments: b.walisSms.segments, language: b.walisSms.language },
      spokenText: b.spokenText,
      briefFromFallback: b.briefFromFallback,
    })),
    candidateWaliSms: args.candidateWaliSms.map((s) => ({
      body: s.body,
      segments: s.segments,
      language: s.language,
    })),
    context: {
      userFirstName: args.userFirstName,
      candidateName: args.candidateName,
      language: language as 'en' | 'ur' | 'ro_ur',
      city: args.proposal.city,
      area: args.proposal.area,
    },
  };

  type InsertRow = { id: string };
  const inserted = await dbWrite<InsertRow[]>('insert.meeting_proposed', async (sb) => {
    const r = await sb
      .from('meetings')
      .insert({
        user_id: args.userId,
        candidate_id: args.candidateTwinId,
        slot_iso: null,
        venue: venueJson,
        wali_contacts: {
          user: { phone: args.userWaliPhone, name: args.userWaliName },
          candidate: { phone: args.candidateWaliPhone, name: args.candidateWaliName },
        },
        meeting_card_url: null,
        status: 'proposed',
        reminders: [],
      })
      .select('id');
    return r as { data: InsertRow[] | null; error: { message: string } | null };
  });
  const firstId = Array.isArray(inserted) ? inserted[0]?.id : undefined;
  if (!firstId) {
    throw new AppError('INTERNAL', 'meetings insert returned no id');
  }
  return firstId;
}

// =========================================================
// Step 6 helpers — load meeting row
// =========================================================

type MeetingRow = {
  id: string;
  user_id: string;
  candidate_id: string;
  status: 'proposed' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  venue: ProposedVenueJson;
  wali_contacts: {
    user: { phone: string; name: string };
    candidate: { phone: string; name: string };
  };
};

async function loadMeetingRow(meetingId: string): Promise<MeetingRow> {
  type Row = MeetingRow;
  const rows = await dbRead<Row[]>('select.meeting_by_id', async (sb) => {
    const r = await sb
      .from('meetings')
      .select('id, user_id, candidate_id, status, venue, wali_contacts')
      .eq('id', meetingId)
      .limit(1);
    return r as { data: Row[] | null; error: { message: string } | null };
  });
  const first = Array.isArray(rows) ? rows[0] : undefined;
  if (!first) throw new AppError('NOT_FOUND', `meeting ${meetingId} not found`);
  return first;
}

// =========================================================
// Step 8 helpers — update meeting to confirmed
// =========================================================

async function updateMeetingToConfirmed(args: {
  meetingId: string;
  finalized: FinalizeMeetingOutput;
  proposals: SlotProposal[];
}): Promise<void> {
  // Carry over the original proposed metadata in `venue.proposed`; replace
  // `venue.chosen` with the locked option for downstream queries.
  const chosenIndex = args.proposals.findIndex(
    (p) => p.slot.slotIso === args.finalized.slotIso && p.venue.name === args.finalized.venue.name
  );
  const venuePatch = {
    chosen: { slotIso: args.finalized.slotIso, venue: args.finalized.venue, chosenIndex },
  };

  type Row = { id: string };
  await dbWrite<Row[]>('update.meeting_confirmed', async (sb) => {
    // Two-step jsonb merge: pull current venue, attach `chosen`, write back.
    // Supabase JS doesn't support partial jsonb updates in one call; this
    // simple read-then-write is fine for our scale.
    const cur = await sb.from('meetings').select('venue').eq('id', args.meetingId).limit(1).single();
    if (cur.error || !cur.data) {
      return { data: null, error: cur.error ?? { message: 'meeting row vanished' } };
    }
    const venue = { ...(cur.data.venue as Record<string, unknown>), ...venuePatch };
    const r = await sb
      .from('meetings')
      .update({
        status: 'confirmed',
        slot_iso: args.finalized.slotIso,
        venue,
        meeting_card_url: args.finalized.meetingCardUrl,
        reminders: args.finalized.reminders,
      })
      .eq('id', args.meetingId)
      .select('id');
    return r as { data: Row[] | null; error: { message: string } | null };
  });
}

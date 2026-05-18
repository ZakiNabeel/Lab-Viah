// POST /feedback/post-meeting — MASTERPLAN §7 + §11 Day 4 exit check.
//
// 4-dimension rating after a meeting. Feeds Twin Forge: produces Twin v2 with
// adjusted dimension_weights (deterministic) + refreshed system_prompt (one
// Gemini Pro call via forgeTwinV2). Also flips the meetings row status to
// 'completed' so it can't be confirmed again.
//
// This is closer to a CRUD endpoint than a workplan (single Gemini call,
// linear flow), so we skip the workplan/trace machinery and log via pino.
// The decision and weight diff still surface to the response so the mobile
// UI can show "Your Twin v2 emphasizes family alignment more after this
// meeting" — visible Twin Forge feedback loop for the demo.

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { ApiResponse } from '../agents/_shared/types.js';
import { requireUserId } from './_auth.middleware.js';
import { forgeTwinV2, type PostMeetingFeedback } from '../agents/twin-forge.agent.js';
import { CANDIDATES } from '../content/candidates.js';
import { dbRead, dbWrite } from '../db/client.js';
import type { TwinSpec } from '../domain/twin.js';
import type { Dimension } from '../domain/dimensions.js';

// =========================================================
// Schemas
// =========================================================

const Rating = z.number().int().min(1).max(5);

const FeedbackBody = z.object({
  meetingId: z.string().uuid(),
  truthfulness: Rating,
  chemistry: Rating,
  family_alignment: Rating,
  would_meet_again: Rating,
  narrative: z.string().min(0).max(2000).optional(),
});

// =========================================================
// Plugin
// =========================================================

export const feedbackRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post('/feedback/post-meeting', async (request, reply) => {
    const parsed = FeedbackBody.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    try {
      const userId = await requireUserId(request);
      const fb: PostMeetingFeedback = {
        truthfulness: parsed.data.truthfulness,
        chemistry: parsed.data.chemistry,
        family_alignment: parsed.data.family_alignment,
        would_meet_again: parsed.data.would_meet_again,
        ...(parsed.data.narrative !== undefined ? { narrative: parsed.data.narrative } : {}),
      };

      // 1. Load meeting + verify ownership + status.
      const meeting = await loadMeeting(parsed.data.meetingId);
      if (meeting.user_id !== userId) {
        throw new AppError('FORBIDDEN', `meeting ${parsed.data.meetingId} does not belong to this user`);
      }
      if (meeting.status !== 'confirmed' && meeting.status !== 'completed') {
        throw new AppError('CONFLICT', `meeting is in status=${meeting.status}; feedback only accepted on confirmed/completed meetings`);
      }

      // 2. Load current Twin v1.
      const current = await loadCurrentTwin(userId);

      // 3. Resolve candidate name (for the Gemini refresh prompt).
      const candidateName = await resolveCandidateName(meeting.candidate_id);

      // 4. Forge v2.
      const v2 = await forgeTwinV2({
        previousSpec: current.spec,
        feedback: fb,
        meetingCandidateName: candidateName,
      });

      // 5. Write new twin row v+1 (do NOT update v1 — keep history).
      const newTwinId = await insertTwinV2(userId, v2.spec);

      // 6. Mark meeting as completed (if not already).
      if (meeting.status !== 'completed') {
        await markMeetingCompleted(parsed.data.meetingId);
      }

      logger.info(
        {
          userId,
          meetingId: parsed.data.meetingId,
          oldTwinId: current.id,
          newTwinId,
          version: v2.spec.version,
          weightsChanged: Object.keys(v2.weightsChanged),
        },
        'feedback: Twin v2 forged from post-meeting feedback'
      );

      return reply.send({
        ok: true,
        data: {
          meetingId: parsed.data.meetingId,
          previousTwinId: current.id,
          newTwinId,
          version: v2.spec.version,
          weightsChanged: v2.weightsChanged,
          systemPromptRefreshed: v2.spec.system_prompt !== current.spec.system_prompt,
        },
      } satisfies ApiResponse<{
        meetingId: string;
        previousTwinId: string;
        newTwinId: string;
        version: number;
        weightsChanged: Partial<Record<Dimension, { from: number; to: number }>>;
        systemPromptRefreshed: boolean;
      }>);
    } catch (err) {
      return handle(err, reply);
    }
  });
};

// =========================================================
// DB helpers
// =========================================================

type MeetingRow = {
  id: string;
  user_id: string;
  candidate_id: string;
  status: 'proposed' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
};

async function loadMeeting(meetingId: string): Promise<MeetingRow> {
  type Row = MeetingRow;
  const rows = await dbRead<Row[]>('select.meeting_for_feedback', async (sb) => {
    const r = await sb
      .from('meetings')
      .select('id, user_id, candidate_id, status')
      .eq('id', meetingId)
      .limit(1);
    return r as { data: Row[] | null; error: { message: string } | null };
  });
  const first = Array.isArray(rows) ? rows[0] : undefined;
  if (!first) throw new AppError('NOT_FOUND', `meeting ${meetingId} not found`);
  return first;
}

type TwinRow = { id: string; spec: TwinSpec };

async function loadCurrentTwin(userId: string): Promise<TwinRow> {
  type Row = TwinRow;
  const rows = await dbRead<Row[]>('select.user_twin_for_feedback', async (sb) => {
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
    throw new AppError('NOT_FOUND', `No Twin found for user ${userId} — finalize onboarding first`);
  }
  return first;
}

async function resolveCandidateName(candidateTwinId: string): Promise<string> {
  // Try DB first; fall back to in-content seed (mirrors find_matches + book_meeting).
  try {
    type Row = { spec: TwinSpec };
    const rows = await dbRead<Row[]>('select.candidate_spec_for_feedback', async (sb) => {
      const r = await sb.from('twins').select('spec').eq('id', candidateTwinId).limit(1);
      return r as { data: Row[] | null; error: { message: string } | null };
    });
    const first = Array.isArray(rows) ? rows[0] : undefined;
    if (first) return first.spec.identity.name;
  } catch {
    /* fall through */
  }
  const seed = CANDIDATES.find((c) => c.id === candidateTwinId);
  return seed?.spec.identity.name ?? '(candidate)';
}

async function insertTwinV2(userId: string, spec: TwinSpec): Promise<string> {
  type Row = { id: string };
  const inserted = await dbWrite<Row[]>('insert.twin_v2', async (sb) => {
    const r = await sb
      .from('twins')
      .insert({
        user_id: userId,
        is_candidate: false,
        version: spec.version,
        spec,
      })
      .select('id');
    return r as { data: Row[] | null; error: { message: string } | null };
  });
  const first = Array.isArray(inserted) ? inserted[0]?.id : undefined;
  if (!first) throw new AppError('INTERNAL', 'twin v2 insert returned no id');
  return first;
}

async function markMeetingCompleted(meetingId: string): Promise<void> {
  type Row = { id: string };
  await dbWrite<Row[]>('update.meeting_completed', async (sb) => {
    const r = await sb
      .from('meetings')
      .update({ status: 'completed' })
      .eq('id', meetingId)
      .select('id');
    return r as { data: Row[] | null; error: { message: string } | null };
  });
}

// =========================================================
// Local error helpers
// =========================================================

function bad(reply: FastifyReply, details: unknown) {
  return reply.code(400).send({
    ok: false,
    error: { code: 'BAD_REQUEST', message: 'Invalid input', details },
  } satisfies ApiResponse<never>);
}

function handle(err: unknown, reply: FastifyReply) {
  if (err instanceof AppError) {
    return reply.code(err.statusCode).send({
      ok: false,
      error: { code: err.code, message: err.message, details: err.details },
    } satisfies ApiResponse<never>);
  }
  throw err;
}

// /book/* routes — MASTERPLAN §7 (booking rows) + §8.3.
//
//   POST /book/initiate   → kicks off book_meeting workplan steps 1-5.
//                           Async — returns flowId + meetingId; client subscribes
//                           to /stream/:flowId for live trace (wali brief
//                           generation, slot proposal, etc).
//   POST /book/confirm    → completes steps 6-9. Sync — fast lock + persist
//                           + mock confirmation SMS, no LLM. Returns the
//                           finalized meeting payload directly.

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { ApiResponse } from '../agents/_shared/types.js';
import { requireUserId } from './_auth.middleware.js';
import {
  startBookMeeting,
  confirmBookMeeting,
  type BookMeetingConfirmOutcome,
} from '../workplans/book-meeting.workplan.js';

// =========================================================
// Schemas
// =========================================================

const RelationSchema = z.enum(['father', 'uncle', 'brother', 'guardian']);

const InitiateBody = z.object({
  candidateTwinId: z.string().uuid(),
  userWaliName: z.string().min(1).max(80),
  userWaliRelation: RelationSchema,
  userWaliPhone: z.string().regex(/^\+\d{7,15}$/, 'userWaliPhone must be E.164'),
  candidateWaliName: z.string().min(1).max(80),
  candidateWaliPhone: z.string().regex(/^\+\d{7,15}$/, 'candidateWaliPhone must be E.164'),
  area: z.string().min(1).max(80).optional(),
});

const ConfirmBody = z.object({
  meetingId: z.string().uuid(),
  slotIndex: z.number().int().min(0).max(9),
});

// =========================================================
// Plugin
// =========================================================

export const bookingRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // ---------- POST /book/initiate ----------
  app.post('/book/initiate', async (request, reply) => {
    const parsed = InitiateBody.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    try {
      const userId = await requireUserId(request);
      const { flowId, meetingIdPromise, promise } = startBookMeeting({
        userId,
        candidateTwinId: parsed.data.candidateTwinId,
        userWaliName: parsed.data.userWaliName,
        userWaliRelation: parsed.data.userWaliRelation,
        userWaliPhone: parsed.data.userWaliPhone,
        candidateWaliName: parsed.data.candidateWaliName,
        candidateWaliPhone: parsed.data.candidateWaliPhone,
        ...(parsed.data.area !== undefined ? { area: parsed.data.area } : {}),
      });

      // Attach a logger to the workplan promise so a rejection doesn't bubble
      // as an unhandled error after the response has been sent.
      promise.catch((err: unknown) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), flowId },
          'book_meeting workplan rejected after kickoff'
        );
      });

      // Wait for the meetings row insert to land so the client gets a real
      // meetingId in the kickoff response. The Wali brief etc. continue to
      // stream over SSE — this only waits as long as the initial twin loads
      // + (eventually) the insert, both of which are sub-second.
      // If the workplan itself rejects before persistence, the meetingId
      // promise rejects too — surface that as a 500-equivalent.
      let meetingId: string;
      try {
        meetingId = await meetingIdPromise;
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(
          'INTERNAL',
          `book_meeting failed before producing a meetingId: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      return reply.send({
        ok: true,
        data: {
          flowId,
          meetingId,
          streamUrl: `/stream/${flowId}`,
        },
      } satisfies ApiResponse<{ flowId: string; meetingId: string; streamUrl: string }>);
    } catch (err) {
      return handle(err, reply);
    }
  });

  // ---------- POST /book/confirm ----------
  app.post('/book/confirm', async (request, reply) => {
    const parsed = ConfirmBody.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    try {
      const userId = await requireUserId(request);
      const outcome = await confirmBookMeeting({
        userId,
        meetingId: parsed.data.meetingId,
        slotIndex: parsed.data.slotIndex,
      });
      return reply.send({
        ok: true,
        data: outcome,
      } satisfies ApiResponse<BookMeetingConfirmOutcome>);
    } catch (err) {
      return handle(err, reply);
    }
  });
};

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

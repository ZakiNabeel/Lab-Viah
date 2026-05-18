// /dispute/* routes — MASTERPLAN §7 (dispute rows) + §8.4.
//
//   POST /dispute/file → runs handle_dispute workplan synchronously.
//     1-2 Gemini calls + a DB write keeps response under 3s. A trace is
//     opened so the flow is auditable via /stream/:flowId even though the
//     SSE stream ends quickly after the workplan settles.

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import type { ApiResponse } from '../agents/_shared/types.js';
import { requireUserId } from './_auth.middleware.js';
import { handleDispute, type HandleDisputeOutcome } from '../workplans/handle-dispute.workplan.js';

// =========================================================
// Schemas
// =========================================================

const FileDisputeBody = z.object({
  meetingId: z.string().uuid(),
  filedBy: z.enum(['user', 'wali']),
  type: z.enum(['no_show', 'misrepresentation', 'ghosting', 'family_rejection', 'other']),
  narrative: z.string().min(10).max(2000),
  counterPartyNarrative: z.string().min(10).max(2000).optional(),
});

// =========================================================
// Plugin
// =========================================================

export const disputeRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // ---------- POST /dispute/file ----------
  app.post('/dispute/file', async (request, reply) => {
    const parsed = FileDisputeBody.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    try {
      const userId = await requireUserId(request);
      const outcome = await handleDispute({
        userId,
        meetingId: parsed.data.meetingId,
        filedBy: parsed.data.filedBy,
        type: parsed.data.type,
        narrative: parsed.data.narrative,
        ...(parsed.data.counterPartyNarrative !== undefined
          ? { counterPartyNarrative: parsed.data.counterPartyNarrative }
          : {}),
      });
      return reply.send({
        ok: true,
        data: {
          disputeId: outcome.disputeId,
          flowId: outcome.flowId,
          resolution: outcome.resolution,
        },
      } satisfies ApiResponse<{
        disputeId: string;
        flowId: string;
        resolution: HandleDisputeOutcome['resolution'];
      }>);
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

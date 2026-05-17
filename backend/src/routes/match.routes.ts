// /match/* + /baseline/* routes — MASTERPLAN §7 (match rows) + Day 3 baseline.
//
//   POST /match/request          → kicks off the find_matches workplan,
//                                  returns { flowId } immediately. The client
//                                  subscribes to GET /stream/:flowId for live
//                                  trace, then polls /match/results/:flowId
//                                  (or reads workplan.finished from the SSE).
//   GET  /match/results/:flowId  → 3 stored CompatibilityReports for the flow.
//   GET  /baseline/match         → non-agentic weighted-distance ranking.
//                                  Required deliverable §11 Day 3; demonstrates
//                                  the agentic uplift in the demo.

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { ApiResponse } from '../agents/_shared/types.js';
import { requireUserId } from './_auth.middleware.js';
import {
  startFindMatches,
  fetchReportsForFlow,
  runBaseline,
  type BaselineRanking,
  type FindMatchesOutput,
  type StoredReportRow,
} from '../workplans/find-matches.workplan.js';

// =========================================================
// Schemas
// =========================================================

const RequestBody = z
  .object({
    // No body fields required today — user_id comes from the JWT — but we
    // accept an empty object so clients can future-proof for weights overrides.
    weightsOverride: z
      .object({
        deen: z.number().min(0).max(1).optional(),
        family: z.number().min(0).max(1).optional(),
        career: z.number().min(0).max(1).optional(),
        finances: z.number().min(0).max(1).optional(),
        kids: z.number().min(0).max(1).optional(),
        conflict: z.number().min(0).max(1).optional(),
        geography: z.number().min(0).max(1).optional(),
        dealbreakers: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const FlowParam = z.object({ flowId: z.string().min(1).max(120) });

// =========================================================
// Plugin
// =========================================================

export const matchRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // ---------- POST /match/request ----------
  app.post('/match/request', async (request, reply) => {
    const parsed = RequestBody.safeParse(request.body ?? {});
    if (!parsed.success) return bad(reply, parsed.error.issues);

    try {
      const userId = await requireUserId(request);
      // The workplan kickoff returns a flowId synchronously and a promise that
      // resolves when the workplan finishes. We attach a final catch so an
      // unhandled rejection doesn't crash the process — the workplan layer
      // already wrote a recovery event before throwing.
      const { flowId, promise } = startFindMatches({ userId });
      promise.catch((err: unknown) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), flowId },
          'find_matches workplan rejected after kickoff'
        );
      });

      return reply.send({
        ok: true,
        data: { flowId, streamUrl: `/stream/${flowId}` },
      } satisfies ApiResponse<{ flowId: string; streamUrl: string }>);
    } catch (err) {
      return handle(err, reply);
    }
  });

  // ---------- GET /match/results/:flowId ----------
  app.get('/match/results/:flowId', async (request, reply) => {
    const parsed = FlowParam.safeParse(request.params);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    try {
      await requireUserId(request);
      const reports = await fetchReportsForFlow(parsed.data.flowId);
      if (reports.length === 0) {
        return reply.code(404).send({
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: `No compatibility reports persisted for flowId ${parsed.data.flowId} yet — the workplan may still be running. Subscribe to /stream/:flowId for workplan.finished, or retry shortly.`,
          },
        } satisfies ApiResponse<never>);
      }
      const topThree = reports.slice(0, 3);
      return reply.send({
        ok: true,
        data: {
          flowId: parsed.data.flowId,
          topThree,
          allDebated: reports,
        },
      } satisfies ApiResponse<{
        flowId: string;
        topThree: StoredReportRow[];
        allDebated: StoredReportRow[];
      }>);
    } catch (err) {
      return handle(err, reply);
    }
  });

  // ---------- GET /baseline/match ----------
  app.get('/baseline/match', async (request, reply) => {
    try {
      const userId = await requireUserId(request);
      const baseline = await runBaseline(userId);
      return reply.send({
        ok: true,
        data: baseline,
      } satisfies ApiResponse<BaselineRanking>);
    } catch (err) {
      return handle(err, reply);
    }
  });
};

// =========================================================
// Local error helpers — same shape as onboarding.routes.ts
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

// Keep the FindMatchesOutput type referenced so an external caller (e.g. tests
// importing from this module) can use it without an extra import.
export type _FindMatchesOutput = FindMatchesOutput;

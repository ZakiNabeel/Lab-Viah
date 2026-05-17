// /onboarding/* routes — MASTERPLAN §7 rows for layer1/2/3/wali/finalize.
//
// All five endpoints sit on top of the onboarding_flow workplan helpers in
// `src/workplans/onboarding.workplan.ts`. The route layer is intentionally
// thin: validate input via Zod, call into the workplan, return the standard
// ApiResponse envelope.
//
// State model: layer1 creates the session and opens the trace bus; subsequent
// layers resume by sessionId; finalize closes the trace and persists Twin v1.

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import type { ApiResponse } from '../agents/_shared/types.js';
import { requireUserId } from './_auth.middleware.js';
import { DIMENSIONS } from '../domain/dimensions.js';
import {
  startOnboarding,
  resumeOnboarding,
  runLayer1,
  runLayer2,
  runLayer3Generate,
  applyLayer3Corrections,
  runLayer4,
  finalizeOnboarding,
  type FinalizeResult,
  type RadarState,
} from '../workplans/onboarding.workplan.js';
import type { OnboardingTurnResult } from '../agents/onboarding.agent.js';
import type { TwinStatement } from '../domain/onboarding-session.js';

// =========================================================
// Shared schemas
// =========================================================

const LangSchema = z.enum(['ur', 'ro_ur', 'en']);

// Layer 1: first call has no sessionId (starts the flow); subsequent calls
// pass it back to resume. Either text or audioBase64 must be present.
const Layer1Body = z
  .object({
    sessionId: z.string().optional(),
    language: LangSchema.optional(),
    text: z.string().min(1).max(2000).optional(),
    audioBase64: z.string().min(1).max(8 * 1024 * 1024).optional(),
  })
  .refine((b) => Boolean(b.text) !== Boolean(b.audioBase64), {
    message: 'Provide exactly one of `text` or `audioBase64`',
  });

const Layer2Body = z.object({
  sessionId: z.string().min(1),
  cardId: z.string().min(1),
  optionId: z.string().min(1),
});

const Layer3GenBody = z.object({ sessionId: z.string().min(1) });
const Layer3CorrectBody = z.object({
  sessionId: z.string().min(1),
  corrections: z
    .array(
      z.object({
        dimension: z.enum(DIMENSIONS),
        agree: z.boolean(),
        correction: z.string().max(500).optional(),
      })
    )
    .min(1)
    .max(3),
});

const WaliBody = z.object({
  sessionId: z.string().min(1),
  wali_phone: z.string().regex(/^\+\d{7,15}$/, 'wali_phone must be E.164'),
  override: z
    .object({
      deen_level: z.enum(['strict', 'practicing', 'moderate', 'cultural', 'secular']).optional(),
      family_setup: z.enum(['joint', 'nuclear', 'single_parent']).optional(),
      kids_timeline: z.enum(['asap', '2-3_yrs', '5_plus', 'none']).optional(),
      dealbreakers: z.array(z.string().min(1).max(120)).max(20).optional(),
    })
    .strict(),
  notes: z.string().max(1000).optional(),
});

const FinalizeBody = z.object({ sessionId: z.string().min(1) });

// =========================================================
// Plugin
// =========================================================

export const onboardingRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // ---------- POST /onboarding/layer1 ----------
  app.post('/onboarding/layer1', async (request, reply) => {
    const parsed = Layer1Body.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    try {
      const userId = await requireUserId(request);
      const { sessionId, language, text, audioBase64 } = parsed.data;

      const ctx = sessionId
        ? resumeOnboarding(sessionId)
        : startOnboarding({ userId, language: language ?? 'en' });

      const turn = await runLayer1({
        session: ctx.session,
        bus: ctx.bus,
        ...(text !== undefined ? { text } : {}),
        ...(audioBase64 !== undefined ? { audioBase64 } : {}),
      });

      return reply.send({
        ok: true,
        data: {
          sessionId: ctx.session.sessionId,
          flowId: ctx.session.sessionId,
          turn,
          turnNumber: ctx.session.layer1Turns,
          payload: ctx.session.payload,
        },
      } satisfies ApiResponse<{
        sessionId: string;
        flowId: string;
        turn: OnboardingTurnResult;
        turnNumber: number;
        payload: typeof ctx.session.payload;
      }>);
    } catch (err) {
      return handle(err, reply);
    }
  });

  // ---------- POST /onboarding/layer2 ----------
  app.post('/onboarding/layer2', async (request, reply) => {
    const parsed = Layer2Body.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    try {
      // Auth still required even though state is server-side — prevents
      // cross-session tampering via a leaked sessionId.
      await requireUserId(request);
      const { sessionId, cardId, optionId } = parsed.data;
      const ctx = resumeOnboarding(sessionId);
      const radar = runLayer2({ session: ctx.session, bus: ctx.bus, cardId, optionId });

      return reply.send({
        ok: true,
        data: { sessionId, flowId: sessionId, radar },
      } satisfies ApiResponse<{ sessionId: string; flowId: string; radar: RadarState }>);
    } catch (err) {
      return handle(err, reply);
    }
  });

  // ---------- POST /onboarding/layer3 ----------
  // Two-mode: if body has `corrections`, apply them; else generate statements.
  app.post('/onboarding/layer3', async (request, reply) => {
    const correctParsed = Layer3CorrectBody.safeParse(request.body);
    if (correctParsed.success) {
      try {
        await requireUserId(request);
        const ctx = resumeOnboarding(correctParsed.data.sessionId);
        const statements = applyLayer3Corrections({
          session: ctx.session,
          bus: ctx.bus,
          corrections: correctParsed.data.corrections,
        });
        return reply.send({
          ok: true,
          data: { sessionId: ctx.session.sessionId, flowId: ctx.session.sessionId, statements },
        } satisfies ApiResponse<{
          sessionId: string;
          flowId: string;
          statements: TwinStatement[];
        }>);
      } catch (err) {
        return handle(err, reply);
      }
    }

    const genParsed = Layer3GenBody.safeParse(request.body);
    if (!genParsed.success) return bad(reply, genParsed.error.issues);

    try {
      await requireUserId(request);
      const ctx = resumeOnboarding(genParsed.data.sessionId);
      const statements = await runLayer3Generate({ session: ctx.session, bus: ctx.bus });
      return reply.send({
        ok: true,
        data: { sessionId: ctx.session.sessionId, flowId: ctx.session.sessionId, statements },
      } satisfies ApiResponse<{
        sessionId: string;
        flowId: string;
        statements: TwinStatement[];
      }>);
    } catch (err) {
      return handle(err, reply);
    }
  });

  // ---------- POST /onboarding/wali ----------
  app.post('/onboarding/wali', async (request, reply) => {
    const parsed = WaliBody.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    try {
      await requireUserId(request);
      const { sessionId, wali_phone, override, notes } = parsed.data;
      const ctx = resumeOnboarding(sessionId);
      const { conflicts } = runLayer4({
        session: ctx.session,
        bus: ctx.bus,
        input: {
          wali_phone,
          override,
          ...(notes !== undefined ? { notes } : {}),
        },
      });
      return reply.send({
        ok: true,
        data: { sessionId, flowId: sessionId, conflicts },
      } satisfies ApiResponse<{ sessionId: string; flowId: string; conflicts: typeof conflicts }>);
    } catch (err) {
      return handle(err, reply);
    }
  });

  // ---------- POST /onboarding/finalize ----------
  app.post('/onboarding/finalize', async (request, reply) => {
    const parsed = FinalizeBody.safeParse(request.body);
    if (!parsed.success) return bad(reply, parsed.error.issues);

    try {
      await requireUserId(request);
      const ctx = resumeOnboarding(parsed.data.sessionId);
      const result = await finalizeOnboarding({ session: ctx.session, bus: ctx.bus });

      return reply.send({
        ok: true,
        data: result,
      } satisfies ApiResponse<FinalizeResult>);
    } catch (err) {
      return handle(err, reply);
    }
  });
};

// =========================================================
// Shared error handling
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
  // Defer to global error handler — bubbles up as 500.
  throw err;
}

// Ensures `FastifyRequest` import is used at runtime (the type-only stays in declaration).
// Keeps TS's `noUnusedParameters: true` honest for thin handlers.
export type _RouteRequest = FastifyRequest;

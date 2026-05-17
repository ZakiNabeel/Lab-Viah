import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getTrace } from '../agents/_shared/trace.js';
import type { TraceEvent } from '../agents/_shared/types.js';

// SSE endpoint for the live agent trace. The mobile app subscribes here with
// flowId returned by /match/request, /book/initiate, etc.
//
// During Session 1 we have no real workplans yet. If the flowId starts with
// "demo_", we emit a heartbeat every second so the frontend team can wire
// against the contract before agents exist. Real flowIds resolve to a TraceBus
// in the registry.

const ParamsSchema = z.object({ flowId: z.string().min(1) });

const HEARTBEAT_MS = 1000;
const DEMO_DURATION_MS = 30_000;

export const streamRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/stream/:flowId', async (request, reply) => {
    const parsed = ParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'Invalid flowId' },
      });
    }
    const { flowId } = parsed.data;

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const send = (event: TraceEvent | { type: 'heartbeat'; ts: number }) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // 15s comment-ping to keep proxies from closing the connection.
    const keepalive = setInterval(() => {
      reply.raw.write(':\n\n');
    }, 15_000);

    if (flowId.startsWith('demo_')) {
      // Session 1 heartbeat path. Stops itself after 30s so test runs don't hang.
      const start = Date.now();
      send({ type: 'heartbeat', ts: start });
      const tick = setInterval(() => {
        const elapsed = Date.now() - start;
        if (elapsed >= DEMO_DURATION_MS) {
          clearInterval(tick);
          clearInterval(keepalive);
          reply.raw.end();
          return;
        }
        send({ type: 'heartbeat', ts: Date.now() });
      }, HEARTBEAT_MS);

      request.raw.on('close', () => {
        clearInterval(tick);
        clearInterval(keepalive);
      });
      return reply;
    }

    const bus = getTrace(flowId);
    if (!bus) {
      clearInterval(keepalive);
      reply.raw.write(
        `data: ${JSON.stringify({
          type: 'error',
          message: `Unknown flowId ${flowId}. Send a request that returns flowId first, or use demo_*.`,
        })}\n\n`
      );
      reply.raw.end();
      return reply;
    }

    const unsubscribe = bus.subscribe((event) => {
      send(event);
      if (event.type === 'workplan.finished') {
        clearInterval(keepalive);
        unsubscribe();
        reply.raw.end();
      }
    });

    request.raw.on('close', () => {
      unsubscribe();
      clearInterval(keepalive);
    });

    return reply;
  });
};

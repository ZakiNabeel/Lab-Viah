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

    // Tell Fastify we're taking over the response. Without this, returning
    // from the handler triggers Fastify's normal send() path AFTER we've
    // already written headers + SSE frames via reply.raw — surfacing as
    // ERR_HTTP_HEADERS_SENT and tearing the connection mid-flight.
    reply.hijack();

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    let ended = false;
    const send = (event: TraceEvent | { type: 'heartbeat'; ts: number }) => {
      if (ended) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // 15s comment-ping to keep proxies from closing the connection.
    const keepalive = setInterval(() => {
      if (ended) return;
      reply.raw.write(':\n\n');
    }, 15_000);

    const endOnce = () => {
      if (ended) return;
      ended = true;
      clearInterval(keepalive);
      try {
        reply.raw.end();
      } catch {
        // raw socket may already be torn down — ignore.
      }
    };

    if (flowId.startsWith('demo_')) {
      // Session 1 heartbeat path. Stops itself after 30s so test runs don't hang.
      const start = Date.now();
      send({ type: 'heartbeat', ts: start });
      const tick = setInterval(() => {
        const elapsed = Date.now() - start;
        if (elapsed >= DEMO_DURATION_MS) {
          clearInterval(tick);
          endOnce();
          return;
        }
        send({ type: 'heartbeat', ts: Date.now() });
      }, HEARTBEAT_MS);

      request.raw.on('close', () => {
        clearInterval(tick);
        endOnce();
      });
      return;
    }

    const bus = getTrace(flowId);
    if (!bus) {
      reply.raw.write(
        `data: ${JSON.stringify({
          type: 'error',
          message: `Unknown flowId ${flowId}. Send a request that returns flowId first, or use demo_*.`,
        })}\n\n`
      );
      endOnce();
      return;
    }

    // TDZ-safe: bus.subscribe replays the buffered event log synchronously
    // (so a late subscriber catches up). If the buffer already contains
    // workplan.finished — which happens in the window between endTrace
    // emitting that event and ACTIVE_BUSES.delete() running — the listener
    // would fire before `unsubscribe` was assigned. Declare with `let` and
    // guard the unsub call so the replay path is safe.
    let unsubscribe: (() => void) | null = null;
    const listener = (event: TraceEvent) => {
      send(event);
      if (event.type === 'workplan.finished') {
        if (unsubscribe) unsubscribe();
        endOnce();
      }
    };
    unsubscribe = bus.subscribe(listener);

    // If the listener already fired endOnce synchronously during replay,
    // the unsubscribe call above ran and the connection is torn down.
    if (ended) return;

    request.raw.on('close', () => {
      if (unsubscribe) unsubscribe();
      endOnce();
    });
  });
};

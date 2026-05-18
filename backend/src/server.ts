import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { env, isProd } from './config.js';
import { logger } from './utils/logger.js';
import { authRoutes } from './routes/auth.routes.js';
import { streamRoutes } from './routes/stream.routes.js';
import { onboardingRoutes } from './routes/onboarding.routes.js';
import { twinRoutes } from './routes/twin.routes.js';
import { matchRoutes } from './routes/match.routes.js';
import { bookingRoutes } from './routes/booking.routes.js';
import { disputeRoutes } from './routes/dispute.routes.js';
import { feedbackRoutes } from './routes/feedback.routes.js';
import { healthCheck } from './db/client.js';
import { geminiSmokeTest } from './agents/_shared/gemini.js';
import type { ApiResponse } from './agents/_shared/types.js';

// Return type intentionally inferred — passing a concrete Pino instance to
// Fastify narrows the Logger generic on the FastifyInstance, which then doesn't
// unify with the declared `FastifyInstance<RawServerDefault, ...>` default.
// Inferring keeps the type honest without forcing a brittle cast.
export async function buildServer() {
  const app = Fastify({
    logger,
    disableRequestLogging: !isProd,
    bodyLimit: 10 * 1024 * 1024, // 10 MB — accommodates base64 audio chunks for STT.
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(sensible);

  app.get('/health', async () => {
    return { ok: true, data: { service: 'rishtaai-backend', env: env.NODE_ENV } } satisfies ApiResponse<{
      service: string;
      env: string;
    }>;
  });

  // Deep health — exercises Supabase + Gemini. Use sparingly (paid path).
  // Always returns ok:true at the envelope level; the per-subsystem booleans
  // (data.db.ok, data.gemini.ok) carry the actual liveness. This keeps the
  // response a valid `ApiOk<...>` while still reporting partial outages.
  app.get('/health/deep', async () => {
    const [db, gemini] = await Promise.all([healthCheck(), geminiSmokeTest()]);
    return {
      ok: true,
      data: { db, gemini, healthy: db.ok && gemini.ok },
    } satisfies ApiResponse<{
      db: typeof db;
      gemini: typeof gemini;
      healthy: boolean;
    }>;
  });

  await app.register(authRoutes);
  await app.register(streamRoutes);
  await app.register(onboardingRoutes);
  await app.register(twinRoutes, { prefix: '/twin' });
  await app.register(matchRoutes);
  await app.register(bookingRoutes);
  await app.register(disputeRoutes);
  await app.register(feedbackRoutes);

  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, 'unhandled route error');
    const status = typeof (err as { statusCode?: number }).statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : 500;
    return reply.code(status).send({
      ok: false,
      error: { code: 'INTERNAL', message: err.message },
    } satisfies ApiResponse<never>);
  });

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'rishtaai-backend listening');
  } catch (err) {
    logger.fatal({ err }, 'failed to start server');
    process.exit(1);
  }
}

// Run only when this file is the entrypoint, not when imported by tests.
// fileURLToPath handles Windows correctly (file:///D:/... → D:\...) — naive
// string comparison breaks on Windows because import.meta.url uses three
// slashes after the scheme but a manually-constructed file:// URL would have
// two, so the check always returned false and main() never ran.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  void main();
}

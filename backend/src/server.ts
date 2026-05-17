import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { env, isProd } from './config.js';
import { logger } from './utils/logger.js';
import { authRoutes } from './routes/auth.routes.js';
import { streamRoutes } from './routes/stream.routes.js';
import { healthCheck } from './db/client.js';
import { geminiSmokeTest } from './agents/_shared/gemini.js';
import type { ApiResponse } from './agents/_shared/types.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger as never,
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
  app.get('/health/deep', async () => {
    const [db, gemini] = await Promise.all([healthCheck(), geminiSmokeTest()]);
    return {
      ok: db.ok && gemini.ok,
      data: { db, gemini },
    } satisfies ApiResponse<{ db: typeof db; gemini: typeof gemini }>;
  });

  await app.register(authRoutes);
  await app.register(streamRoutes);

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
const invokedDirectly = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`;
if (invokedDirectly) {
  void main();
}

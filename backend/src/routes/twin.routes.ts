// /twin/* routes — MASTERPLAN §7 row for GET /twin/me.
//
// CRUD-ish endpoint; no workplan/trace machinery per ANTIGRAVITY.md §8.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireUserId } from './_auth.middleware.js';
import { dbRead } from '../db/client.js';
import { AppError } from '../utils/errors.js';
import type { ApiResponse } from '../agents/_shared/types.js';
import type { TwinSpec } from '../domain/twin.js';

export async function twinRoutes(app: FastifyInstance): Promise<void> {
  // ---------- GET /twin/me ----------
  app.get('/me', async (request, reply) => {
    try {
      const userId = await requireUserId(request);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let row: Record<string, any>;

      try {
        row = await dbRead('twin.me', async (sb) =>
          sb
            .from('twins')
            .select('id, user_id, version, spec, created_at, updated_at, is_candidate')
            .eq('user_id', userId)
            .eq('is_candidate', false)
            .order('version', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
        );
      } catch (err) {
        if (err instanceof AppError && err.code === 'NOT_FOUND') {
          throw new AppError(
            'NOT_FOUND',
            'no twin found for user; complete onboarding first'
          );
        }
        throw err;
      }

      const body: ApiResponse<{
        twinId: string;
        spec: TwinSpec;
        version: number;
        createdAt: string;
        updatedAt: string;
      }> = {
        ok: true,
        data: {
          twinId: row['id'] as string,
          spec: row['spec'] as TwinSpec,
          version: row['version'] as number,
          createdAt: row['created_at'] as string,
          updatedAt: row['updated_at'] as string,
        },
      };

      return reply.send(body);
    } catch (err) {
      return handle(err, reply);
    }
  });
}

// =========================================================
// Shared error handling
// =========================================================

function handle(err: unknown, reply: FastifyReply) {
  if (err instanceof AppError) {
    return reply.code(err.statusCode).send({
      ok: false,
      error: { code: err.code, message: err.message, details: err.details },
    } satisfies ApiResponse<never>);
  }
  throw err;
}

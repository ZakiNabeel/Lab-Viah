import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';
import { withRetry } from '../utils/retry.js';

// Server-side client uses service-role key — bypasses RLS. Never expose to the mobile app.
// The MASTERPLAN mandates that every Supabase write goes through this module, so we centralize
// retry policy and error surfacing here.

export const supabase: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-rishtaai-source': 'backend' } },
  }
);

// Public anon client — used only for the OTP flow which is meant to mirror what the
// mobile client would do. Keeps the service-role key out of OTP code paths.
export const supabasePublic: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

export type DbResult<T> = { data: T; error: null } | { data: null; error: AppError };

export async function dbRead<T>(
  label: string,
  fn: (sb: SupabaseClient) => Promise<{ data: T | null; error: { message: string } | null }>
): Promise<T> {
  return withRetry(
    `db.read.${label}`,
    async () => {
      const { data, error } = await fn(supabase);
      if (error) {
        throw new AppError('UPSTREAM_FAILURE', `Supabase read failed: ${label}`, {
          cause: error.message,
        });
      }
      if (data === null) {
        throw new AppError('NOT_FOUND', `${label} returned no row`);
      }
      return data;
    },
    {
      attempts: 3,
      baseDelayMs: 200,
      shouldRetry: (err) =>
        !(err instanceof AppError) || err.code === 'UPSTREAM_FAILURE' || err.code === 'TIMEOUT',
    }
  );
}

export async function dbWrite<T>(
  label: string,
  fn: (sb: SupabaseClient) => Promise<{ data: T | null; error: { message: string } | null }>
): Promise<T> {
  return withRetry(
    `db.write.${label}`,
    async () => {
      const { data, error } = await fn(supabase);
      if (error) {
        throw new AppError('UPSTREAM_FAILURE', `Supabase write failed: ${label}`, {
          cause: error.message,
        });
      }
      if (data === null) {
        throw new AppError('INTERNAL', `${label} returned no data after write`);
      }
      return data;
    },
    {
      attempts: 3,
      baseDelayMs: 200,
      shouldRetry: (err) =>
        !(err instanceof AppError) || err.code === 'UPSTREAM_FAILURE' || err.code === 'TIMEOUT',
    }
  );
}

export async function healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    // Cheap call: count of users with limit 0. Confirms DB reachable + auth works.
    const { error } = await supabase.from('users').select('id', { count: 'exact', head: true });
    const latencyMs = Date.now() - start;
    if (error) {
      logger.warn({ err: error.message, latencyMs }, 'supabase health check failed');
      return { ok: false, latencyMs };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    logger.warn({ err, latencyMs }, 'supabase health check threw');
    return { ok: false, latencyMs };
  }
}

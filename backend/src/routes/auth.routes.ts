import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { supabasePublic, supabase } from '../db/client.js';
import { env, isProd } from '../config.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { ApiResponse } from '../agents/_shared/types.js';

// Phone numbers in E.164. Supabase Auth handles the actual OTP delivery
// (Twilio or its built-in test provider in dev). We do not generate codes ourselves.
//
// Dev bypass: when env.DEV_OTP_BYPASS is true and NODE_ENV !== 'production',
// the bypass branch accepts a fixed phone+code pair without calling Twilio.
// It still returns a REAL Supabase JWT (via admin.createUser + signInWithPassword)
// so RLS and downstream auth work identically. MASTERPLAN §7 API surface is
// unchanged — the route shape, request body, and response body are identical
// between the bypass path and the real OTP path.

const PhoneSchema = z
  .string()
  .regex(/^\+\d{7,15}$/, 'Phone must be E.164 format like +923001234567');

const StartBody = z.object({ phone: PhoneSchema });
const VerifyBody = z.object({ phone: PhoneSchema, otp: z.string().regex(/^\d{4,8}$/) });

type VerifyResponse = {
  access_token: string;
  refresh_token: string;
  expires_at: number | null;
  user_id: string | null;
};

function devBypassActive(): boolean {
  return !isProd && env.DEV_OTP_BYPASS;
}

function devPhoneMatches(phone: string): boolean {
  return devBypassActive() && phone === env.DEV_OTP_PHONE;
}

function devCodeMatches(phone: string, otp: string): boolean {
  return devPhoneMatches(phone) && otp === env.DEV_OTP_CODE;
}

/**
 * Synthesizes a local-only email tied to a phone number, used as the auth
 * identifier for the dev bypass. Format: dev-<digits>@rishtaai-dev.local.
 * .local is an IANA-reserved TLD so it cannot collide with a real domain.
 */
function devEmailFor(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  return `dev-${digits}@rishtaai-dev.local`;
}

/**
 * Backs the dev-bypass phone with a real Supabase auth user (created if missing)
 * and returns a real session via signInWithPassword. Real JWT → real RLS.
 *
 * IMPORTANT: We sign in with EMAIL+password, not PHONE+password, because phone-
 * based sign-in requires the Phone auth provider to be enabled on the Supabase
 * project — which requires Twilio. The synthetic email is internal-only; from
 * the app's perspective the user is still identified by the phone (stored in
 * our `users` table). MASTERPLAN §7 API surface is unchanged.
 */
async function devBypassVerify(phone: string): Promise<VerifyResponse> {
  const password = env.DEV_OTP_PASSWORD;
  if (!password) {
    throw new AppError(
      'INTERNAL',
      'DEV_OTP_BYPASS is enabled but DEV_OTP_PASSWORD is not set. Generate a strong password and add it to .env.'
    );
  }

  const email = devEmailFor(phone);

  // Attempt sign-in first. If it works, the dev user already exists.
  const initial = await supabase.auth.signInWithPassword({ email, password });
  let session = initial.data?.session ?? null;
  let user = initial.data?.user ?? null;

  if (!session) {
    // Create the dev user via admin API and retry sign-in.
    const created = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { dev_bypass: true, phone },
    });
    if (created.error) {
      throw new AppError(
        'INTERNAL',
        'Dev bypass: failed to create or sign in dev user. If DEV_OTP_PASSWORD was rotated, delete the user from Supabase Auth → Users and retry.',
        { supabase: created.error.message }
      );
    }
    const retry = await supabase.auth.signInWithPassword({ email, password });
    if (!retry.data?.session) {
      throw new AppError('INTERNAL', 'Dev bypass: sign-in after create failed', {
        supabase: retry.error?.message ?? 'no session',
      });
    }
    session = retry.data.session;
    user = retry.data.user;
  }

  // Upsert into our app's users table (the auth.users row exists separately).
  // Phone lives only in OUR users table; auth.users has the synthetic email.
  const userId = user?.id ?? null;
  if (userId) {
    const { error: upsertErr } = await supabase
      .from('users')
      .upsert({ id: userId, phone, last_active: new Date().toISOString() }, { onConflict: 'id' });
    if (upsertErr) {
      logger.warn({ phone, err: upsertErr.message }, 'dev-bypass: failed to upsert users row');
    }
  }

  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at ?? null,
    user_id: userId,
  };
}

export const authRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post('/auth/otp/start', async (request, reply) => {
    const parsed = StartBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'Invalid phone', details: parsed.error.issues },
      } satisfies ApiResponse<never>);
    }
    const { phone } = parsed.data;

    // Dev bypass — short-circuit before hitting Twilio.
    if (devPhoneMatches(phone)) {
      logger.info({ phone }, 'auth: dev OTP bypass — /start short-circuited');
      return reply.send({
        ok: true,
        data: { sent: true, dev: true },
      } satisfies ApiResponse<{ sent: true; dev: true }>);
    }

    try {
      const { error } = await supabasePublic.auth.signInWithOtp({ phone });
      if (error) {
        logger.warn({ phone, err: error.message }, 'otp start failed');
        throw new AppError('UPSTREAM_FAILURE', 'Failed to send OTP', { cause: error.message });
      }
      return reply.send({ ok: true, data: { sent: true } } satisfies ApiResponse<{ sent: true }>);
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({
          ok: false,
          error: { code: err.code, message: err.message, details: err.details },
        } satisfies ApiResponse<never>);
      }
      throw err;
    }
  });

  app.post('/auth/otp/verify', async (request, reply) => {
    const parsed = VerifyBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'Invalid input', details: parsed.error.issues },
      } satisfies ApiResponse<never>);
    }
    const { phone, otp } = parsed.data;

    try {
      // Dev bypass path — only when env flag is on, NODE_ENV is non-prod,
      // AND both phone and code match the configured pair.
      if (devCodeMatches(phone, otp)) {
        logger.info({ phone }, 'auth: dev OTP bypass — /verify accepted');
        const result = await devBypassVerify(phone);
        return reply.send({ ok: true, data: result } satisfies ApiResponse<VerifyResponse>);
      }

      // Production / real Twilio path.
      const { data, error } = await supabasePublic.auth.verifyOtp({
        phone,
        token: otp,
        type: 'sms',
      });
      if (error || !data.session) {
        logger.info({ phone, err: error?.message }, 'otp verify failed');
        throw new AppError('UNAUTHORIZED', 'Invalid or expired OTP', {
          cause: error?.message ?? 'no session',
        });
      }

      // Upsert a row in users so we always have one to reference. Idempotent.
      const { error: upsertErr } = await supabase
        .from('users')
        .upsert(
          { id: data.user?.id, phone, last_active: new Date().toISOString() },
          { onConflict: 'id' }
        );
      if (upsertErr) {
        logger.warn({ phone, err: upsertErr.message }, 'failed to upsert user row');
      }

      return reply.send({
        ok: true,
        data: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at ?? null,
          user_id: data.user?.id ?? null,
        },
      } satisfies ApiResponse<VerifyResponse>);
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({
          ok: false,
          error: { code: err.code, message: err.message, details: err.details },
        } satisfies ApiResponse<never>);
      }
      throw err;
    }
  });
};

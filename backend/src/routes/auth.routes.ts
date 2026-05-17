import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { supabasePublic, supabase } from '../db/client.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { ApiResponse } from '../agents/_shared/types.js';

// Phone numbers in E.164. Supabase Auth handles the actual OTP delivery
// (Twilio or its built-in test provider in dev). We do not generate codes ourselves.

const PhoneSchema = z
  .string()
  .regex(/^\+\d{7,15}$/, 'Phone must be E.164 format like +923001234567');

const StartBody = z.object({ phone: PhoneSchema });
const VerifyBody = z.object({ phone: PhoneSchema, otp: z.string().regex(/^\d{4,8}$/) });

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
        .upsert({ id: data.user?.id, phone, last_active: new Date().toISOString() }, { onConflict: 'id' });
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
      } satisfies ApiResponse<{
        access_token: string;
        refresh_token: string;
        expires_at: number | null;
        user_id: string | null;
      }>);
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

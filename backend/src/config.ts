import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL_PRIMARY: z.string().default('gemini-2.0-pro-exp'),
  GEMINI_MODEL_FALLBACK: z.string().default('gemini-2.0-flash-exp'),

  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),

  TRACE_DUMP_TO_FILE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  // ---- Dev OTP bypass ----
  // When DEV_OTP_BYPASS=true and NODE_ENV !== 'production', /auth/otp/verify
  // accepts a hardcoded phone+code pair without calling Twilio. The bypass
  // creates (or finds) a real Supabase auth user via the admin API and returns
  // a real, RLS-compatible Supabase JWT. The MASTERPLAN §7 API surface stays
  // identical between dev and production — only the underlying credential
  // verification differs. In production this flag MUST be false and Twilio
  // (or another Supabase SMS provider) must be configured.
  DEV_OTP_BYPASS: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  DEV_OTP_PHONE: z.string().default('+923001234567'),
  DEV_OTP_CODE: z.string().default('123456'),
  DEV_OTP_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

// Hard fail if someone ever sets DEV_OTP_BYPASS=true in production.
if (isProd && env.DEV_OTP_BYPASS) {
  throw new Error(
    'DEV_OTP_BYPASS=true is not allowed when NODE_ENV=production. Configure Twilio (or another Supabase SMS provider) and set DEV_OTP_BYPASS=false.'
  );
}

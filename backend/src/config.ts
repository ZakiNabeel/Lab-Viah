// ---- Railway SA-JSON adapter ----
// On Railway (and other PaaS), secret files can't be mounted. Instead we
// paste the full service-account JSON into an env var. This block decodes
// it, writes it to a temp file, and sets GOOGLE_APPLICATION_CREDENTIALS
// BEFORE the Zod schema runs — so the validator sees the file-path env
// var as set, and every ADC-aware library (Vertex SDK, TTS, STT) picks
// it up automatically.
// Local dev: GOOGLE_APPLICATION_CREDENTIALS_JSON is absent, so this is a no-op.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env['GOOGLE_APPLICATION_CREDENTIALS_JSON'] && !process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
  const saPath = join(tmpdir(), 'rishtaai-sa.json');
  writeFileSync(saPath, process.env['GOOGLE_APPLICATION_CREDENTIALS_JSON'], { encoding: 'utf-8', mode: 0o600 });
  process.env['GOOGLE_APPLICATION_CREDENTIALS'] = saPath;
}

import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Self-healing check: If GOOGLE_APPLICATION_CREDENTIALS contains the raw GCP JSON key string,
// write it to a temporary file in the container and point the env variable to that file path.
// This allows pasting the raw JSON directly into the Railway dashboard.
if (process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim().startsWith('{')) {
  try {
    const tempFilePath = path.join(os.tmpdir(), 'gcp-creds.json');
    fs.writeFileSync(tempFilePath, process.env.GOOGLE_APPLICATION_CREDENTIALS.trim(), 'utf8');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tempFilePath;
  } catch (err) {
    console.error('Failed to write GOOGLE_APPLICATION_CREDENTIALS JSON to temp file:', err);
  }
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Project URL only (https://<ref>.supabase.co). The Supabase JS client appends
  // its own /rest/v1/, /auth/v1/, /storage/v1/ sub-paths. We auto-strip /rest/v1
  // and trailing slashes here because copying the "API URL" from the Supabase
  // dashboard gives the PostgREST URL (with /rest/v1/ suffix), which silently
  // breaks the Auth client even though DB queries appear to work.
  SUPABASE_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '')),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),

  // ---- Vertex AI (Gemini) ----
  // We use Vertex AI (GCP-billed) instead of Google AI Studio. Auth is via
  // Application Default Credentials picked up from GOOGLE_APPLICATION_CREDENTIALS
  // — the same service-account JSON used by STT/TTS. The service account needs
  // the `Vertex AI User` role (roles/aiplatform.user) on the project.
  GCP_PROJECT_ID: z.string().min(1),
  GCP_LOCATION: z.string().min(1).default('us-central1'),
  // Vertex uses explicit versioned model names — no `*-latest` aliases. Pin to
  // GA models for stability; opt into preview models per session if needed.
  VERTEX_MODEL_PRIMARY: z.string().default('gemini-2.5-pro'),
  VERTEX_MODEL_FALLBACK: z.string().default('gemini-2.5-flash'),

  // Service-account JSON path. Vertex AI SDK reads this via ADC; STT/TTS use
  // it directly. Required when calling Vertex; optional otherwise (the
  // smoke-test / health check will surface a clear error if it's missing).
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1),
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
    .transform((v) => v.trim() === 'true')
    .default('false'),
  // Trim defensively: Railway / Vercel / similar dashboards preserve trailing
  // spaces silently, so `+923001234567 ` !== `+923001234567` slips past the
  // strict-equality check in auth.routes.devPhoneMatches and falls through to
  // the real Twilio path → "Unsupported phone provider".
  DEV_OTP_PHONE: z
    .string()
    .transform((v) => v.trim())
    .default('+923001234567'),
  DEV_OTP_CODE: z
    .string()
    .transform((v) => v.trim())
    .default('123456'),
  DEV_OTP_PASSWORD: z
    .string()
    .transform((v) => v.trim())
    .optional(),
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

// Warn (but don't crash) if DEV_OTP_BYPASS is left on in production.
// For the hackathon demo deploy, judges authenticate via the bypass.
// A real production deployment should set DEV_OTP_BYPASS=false and wire Twilio.
if (isProd && env.DEV_OTP_BYPASS) {
  // eslint-disable-next-line no-console
  console.warn('[config] DEV_OTP_BYPASS=true in production — OK for hackathon demo, disable before real launch.');
}

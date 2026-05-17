// Vitest setup. Loads placeholder env so config.ts parses without real credentials.
// Real integration tests should override these from the environment.
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'warn';
process.env.SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key';
process.env.SUPABASE_ANON_KEY ??= 'placeholder-anon-key';
process.env.SUPABASE_JWT_SECRET ??= 'placeholder-jwt-secret';
process.env.GCP_PROJECT_ID ??= 'placeholder-project';
process.env.GCP_LOCATION ??= 'us-central1';
process.env.VERTEX_MODEL_PRIMARY ??= 'gemini-2.5-pro';
process.env.VERTEX_MODEL_FALLBACK ??= 'gemini-2.5-flash';
process.env.GOOGLE_APPLICATION_CREDENTIALS ??= 'placeholder-creds.json';

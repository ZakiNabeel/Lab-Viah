// Vitest setup. Loads placeholder env so config.ts parses without real credentials.
// Real integration tests should override these from the environment.
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'warn';
process.env.SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key';
process.env.SUPABASE_ANON_KEY ??= 'placeholder-anon-key';
process.env.SUPABASE_JWT_SECRET ??= 'placeholder-jwt-secret';
process.env.GEMINI_API_KEY ??= 'placeholder-gemini-key';

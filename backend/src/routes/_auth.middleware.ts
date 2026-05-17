// Auth middleware — extracts and validates the Supabase JWT carried in
// Authorization: Bearer <token>. Returns the authenticated user_id or
// surfaces 401.
//
// Implementation note: we use `supabase.auth.getUser(token)` rather than
// verifying the JWT signature locally. Local HS256 verification would need
// `jsonwebtoken` (a new dep — explicitly avoided per CLAUDE rules). The
// GoTrue call adds ~50–100ms per request but is correct, cheap, and zero-
// dep. Session 5 polish can swap in local verification if latency matters.

import type { FastifyRequest } from 'fastify';
import { supabase } from '../db/client.js';
import { AppError } from '../utils/errors.js';

const BEARER = /^Bearer\s+(.+)$/i;

export async function requireUserId(request: FastifyRequest): Promise<string> {
  const auth = request.headers['authorization'];
  if (!auth || typeof auth !== 'string') {
    throw new AppError('UNAUTHORIZED', 'Missing Authorization header');
  }
  const match = BEARER.exec(auth);
  if (!match) {
    throw new AppError('UNAUTHORIZED', 'Authorization header must be `Bearer <jwt>`');
  }
  const token = match[1]!;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user?.id) {
    throw new AppError('UNAUTHORIZED', 'Invalid or expired access token', {
      cause: error?.message ?? 'no user',
    });
  }
  return data.user.id;
}

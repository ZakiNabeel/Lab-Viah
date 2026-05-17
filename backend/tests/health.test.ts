import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';

describe('GET /health', () => {
  it('returns ok with service name', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.service).toBe('rishtaai-backend');
    await app.close();
  });
});

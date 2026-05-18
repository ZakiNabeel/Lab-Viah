// Dispute Agent happy-path test. Mocks Gemini + Supabase. Verifies
// runDisputeAgent returns a valid DisputeResolution and emits a clean trace.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/agents/_shared/gemini.js', () => ({
  geminiCall: vi.fn(async (input: { prompt: string }) => {
    if (input.prompt.includes("RishtaAI's Dispute Moderator")) {
      return {
        text: JSON.stringify({
          type: 'no_show',
          severity: 3,
          action: 'warning',
          reputation_impact: [{ party: 'counterparty', delta: -0.1, reason: 'No-show without notice' }],
          blocklist_changes: [],
          escalated: false,
          rationale: 'Confirmed no-show with no advance notice.',
          outreach: [{ toRole: 'wali_user', messageKey: 'resolved' }],
        }),
        modelUsed: 'mock',
        latencyMs: 1,
        fallbackUsed: false,
      };
    }
    return { text: '{}', modelUsed: 'mock', latencyMs: 1, fallbackUsed: false };
  }),
  geminiSmokeTest: vi.fn(async () => ({ ok: true, modelUsed: 'mock', latencyMs: 1 })),
}));

vi.mock('../src/db/client.js', () => {
  const supabase = { from: () => ({ insert: () => ({ select: () => Promise.resolve({ data: [{ id: 'fake' }], error: null }) }) }) };
  return {
    supabase,
    supabasePublic: supabase,
    dbWrite: async () => [{ id: 'fake' }],
    dbRead: async () => null,
    healthCheck: async () => ({ ok: true, latencyMs: 1 }),
  };
});

import { startTrace, endTrace } from '../src/agents/_shared/trace.js';
import { runDisputeAgent } from '../src/agents/dispute.agent.js';
import { CANDIDATES } from '../src/content/candidates.js';

describe('Dispute Agent — happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces a valid DisputeResolution and emits trace events', async () => {
    const bus = startTrace('handle_dispute', { flowId: 'dispute-test', userId: 'test-user' });

    const out = await runDisputeAgent(
      {
        disputeType: 'no_show',
        filedBy: 'user',
        narrative: 'The candidate did not show up at the agreed venue and did not respond to messages for two hours.',
        filerSpec: CANDIDATES[6]!.spec,
        counterpartySpec: CANDIDATES[0]!.spec,
      },
      bus
    );

    expect(out.resolution.severity).toBeGreaterThanOrEqual(1);
    expect(out.resolution.severity).toBeLessThanOrEqual(5);
    expect(['no_action', 'warning', 'shadowban', 'flag_for_human_review', 'mutual_close']).toContain(out.resolution.action);
    expect(out.resolution.escalated).toBe(false);
    expect(out.resolution.rationale.length).toBeGreaterThan(0);
    expect(bus.events().length).toBeGreaterThanOrEqual(5);

    await endTrace(bus, out);
  });
});

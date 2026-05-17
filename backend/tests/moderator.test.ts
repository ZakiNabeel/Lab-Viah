// Moderator + Twin-debate happy-path test.
//
// Strategy mirrors `tests/onboarding.test.ts`: mock Gemini deterministically
// off the prompt shape, mock Supabase out of the loop entirely. Exercises:
//   - User Twin + Candidate Twin turns parsing the same Twin-turn schema.
//   - Moderator's per-dimension scoring + final synthesis loop.
//   - find_matches workplan kickoff (without persistence, via .promise).
//
// The unit-test contract here is "≤10 lines of assertions" per the session-3
// quality bar; the surrounding setup is the cost of mocking two collaborators.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- Gemini mock — keyed off prompt phrases ----------
vi.mock('../src/agents/_shared/gemini.js', () => ({
  geminiCall: vi.fn(async (input: { prompt: string }) => {
    const p = input.prompt;
    if (p.includes('It is your turn in a compatibility debate')) {
      return {
        text: JSON.stringify({
          statement: 'I expect a household built on shared deen and direct conversation.',
          willingness_to_compromise: 0.4,
          dealbreaker_hit: false,
          dealbreaker_reason: '',
        }),
        modelUsed: 'mock',
        latencyMs: 1,
        fallbackUsed: false,
      };
    }
    if (p.includes('Conduct ONE round of a compatibility debate')) {
      return {
        text: JSON.stringify({
          user_statement: 'I expect a household built on shared deen and direct conversation.',
          user_willingness: 0.4,
          user_dealbreaker_hit: false,
          user_dealbreaker_reason: '',
          candidate_statement: 'I value the same — deen is central to how I want to raise a family.',
          candidate_willingness: 0.45,
          candidate_dealbreaker_hit: false,
          candidate_dealbreaker_reason: '',
          score: 0.78,
          evidence: 'Both parties value direct conversation and shared deen; modest friction on rigor.',
          friction_level: 'low',
        }),
        modelUsed: 'mock',
        latencyMs: 1,
        fallbackUsed: false,
      };
    }
    if (p.includes('final-report narrative')) {
      return {
        text: JSON.stringify({
          top_strengths: ['Aligned on deen practice', 'Both want kids in 2-3 years', 'Same city'],
          top_friction_points: ['Different career ambitions', 'Lifestyle gap', 'Conflict style mismatch'],
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

// ---------- Supabase mock — minimal surface used by trace persistence ----------
vi.mock('../src/db/client.js', () => {
  const builder = {
    insert: () => ({
      select: () => Promise.resolve({ data: [{ id: 'fake-id' }], error: null }),
      then: (resolve: (v: { data: null; error: null }) => unknown) =>
        resolve({ data: null, error: null }),
    }),
  };
  const supabase = { from: () => builder };
  return {
    supabase,
    supabasePublic: supabase,
    dbWrite: async () => [{ id: 'fake-id' }],
    dbRead: async () => null,
    healthCheck: async () => ({ ok: true, latencyMs: 1 }),
  };
});

// ---------- Test ----------
import { startTrace, endTrace } from '../src/agents/_shared/trace.js';
import { runDebate } from '../src/agents/moderator.agent.js';
import { CANDIDATES } from '../src/content/candidates.js';

describe('Moderator 8-dim debate — happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs an 8-dimension debate and produces a valid CompatibilityReport', async () => {
    const userSpec = CANDIDATES[6]!.spec; // Hamza — male user
    const candidate = CANDIDATES[0]!; // Ayesha — female candidate
    const bus = startTrace('find_matches', { flowId: 'test-flow', userId: 'test-user' });

    const out = await runDebate(
      { userSpec, candidateSpec: candidate.spec, candidateId: candidate.id },
      bus
    );

    expect(out.dimensionsScored).toBe(8);
    expect(out.report.overall_score).toBeGreaterThan(0);
    expect(out.report.overall_score).toBeLessThanOrEqual(1);
    expect(out.report.top_strengths).toHaveLength(3);
    expect(out.report.top_friction_points).toHaveLength(3);
    expect(['strong_match', 'conditional_match', 'not_recommended']).toContain(
      out.report.recommendation
    );
    expect(bus.events().length).toBeGreaterThanOrEqual(15);

    await endTrace(bus, out);
  });
});

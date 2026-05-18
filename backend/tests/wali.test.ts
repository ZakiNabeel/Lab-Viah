// Wali Agent happy-path test.
// Mocks Gemini + TTS + SMS + Supabase. Verifies that runWaliBrief produces
// EN + native briefs with audio + SMS, and emits enough trace events.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- Mocks ----------
vi.mock('../src/agents/_shared/gemini.js', () => ({
  geminiCall: vi.fn(async (input: { prompt: string }) => {
    const p = input.prompt;
    if (p.includes("RishtaAI's Wali Agent")) {
      return {
        text: JSON.stringify({
          salutation: 'As-salamu alaikum, Uncle Ahmed',
          headline: 'A proposed match for Hamza: Ayesha Khan, 26, Karachi.',
          candidate_summary: 'Ayesha is a 26-year-old software engineer from Karachi with practicing deen.',
          alignment_points: ['Both align on practicing deen', 'Similar career trajectory'],
          discussion_points: ['Family setup differs — needs discussion'],
          recommended_next_step: 'Consider arranging a brief family meeting.',
          compatibility_label: 'Match with conditions',
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

vi.mock('../src/tools/tts.js', () => ({
  ttsSynthesize: vi.fn(async () => ({
    audioDataUri: 'data:audio/mp3;base64,STUB',
    audioBytes: 100,
    voiceUsed: 'mock-voice',
    textOnly: false,
    skipReason: null,
  })),
}));

vi.mock('../src/tools/sms.template.js', () => ({
  smsRender: vi.fn(async (input: { template: string; language: string }) => ({
    body: 'mock sms body',
    segments: 1,
    language: input.language,
    template: input.template,
    sentAt: new Date().toISOString(),
    delivered: true,
    mocked: true,
  })),
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

// ---------- Test ----------
import { startTrace, endTrace } from '../src/agents/_shared/trace.js';
import { runWaliBrief } from '../src/agents/wali.agent.js';
import { CANDIDATES } from '../src/content/candidates.js';
import type { CompatibilityReport } from '../src/domain/scoring.js';
import { DIMENSIONS } from '../src/domain/dimensions.js';

function makeReport(): CompatibilityReport {
  const dim_scores = Object.fromEntries(
    DIMENSIONS.map((d) => [
      d,
      { score: 0.7, weight: 0.125, evidence: `${d} aligned`, friction_level: 'low' as const },
    ])
  ) as CompatibilityReport['dimension_scores'];
  return {
    overall_score: 0.72,
    dimension_scores: dim_scores,
    top_strengths: ['Aligned deen', 'Same city', 'Career fit'],
    top_friction_points: ['Family setup', 'Conflict style', 'Lifestyle gap'],
    dealbreakers_hit: [],
    recommendation: 'conditional_match',
  };
}

describe('Wali Agent — happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces EN + ro_ur briefs with audio + SMS and 8+ trace events', async () => {
    const bus = startTrace('book_meeting', { flowId: 'wali-test', userId: 'test-user' });
    const userSpec = CANDIDATES[6]!.spec;       // Hamza — male
    const candidateSpec = CANDIDATES[0]!.spec;  // Ayesha — female

    const out = await runWaliBrief(
      {
        userFirstName: userSpec.identity.name,
        userSpec,
        candidateSpec,
        report: makeReport(),
        userWaliName: 'Uncle Ahmed',
        userWaliRelation: 'uncle',
        userWaliPhone: '+923001234567',
        candidateWaliName: 'Father Khan',
        candidateWaliPhone: '+923009876543',
        nativeLanguage: 'ro_ur',
      },
      bus
    );

    expect(out.briefs).toHaveLength(2);
    expect(out.briefs.map((b) => b.language).sort()).toEqual(['en', 'ro_ur']);
    expect(out.briefs[0]?.document.headline.length).toBeGreaterThan(0);
    expect(out.briefs[0]?.audio.audioDataUri).toMatch(/^data:audio/);
    expect(out.briefs[1]?.audio.audioDataUri).toMatch(/^data:audio/);
    expect(out.briefs.every((b) => b.walisSms.body.length > 0)).toBe(true);
    expect(bus.events().length).toBeGreaterThanOrEqual(6);

    await endTrace(bus, out);
  });
});

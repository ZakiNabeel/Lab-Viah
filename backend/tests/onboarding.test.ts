// Onboarding workplan — happy-path test.
//
// Strategy: exercise the workplan helpers directly with Gemini + Supabase
// MOCKED. Tests should NOT depend on real Gemini quota or a live Supabase
// project, both for speed and for CI hermeticity. Route-level tests are
// covered by `health.test.ts`; we trust Fastify to dispatch correctly.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- Mocks ----------
// Mock the Gemini wrapper to return deterministic JSON keyed off the prompt
// shape. We watch for a phrase unique to each prompt type.
vi.mock('../src/agents/_shared/gemini.js', () => ({
  geminiCall: vi.fn(async (input: { prompt: string }) => {
    const p = input.prompt;
    if (p.includes('Conversation so far')) {
      // Onboarding Agent turn — return extracted identity + high confidence.
      return {
        text: JSON.stringify({
          reply: 'Got it.',
          extracted: {
            identity: { name: 'Test User', age: 28, gender: 'male', city: 'Karachi' },
            deen_level: 'practicing',
            family_setup: 'nuclear',
            career: { current: 'Software engineer', five_yr_goal: 'Senior engineer' },
            kids_timeline: '2-3_yrs',
            geography: { current_city: 'Karachi', ten_yr_pref: 'Karachi', flexible: true },
            dealbreakers: ['No smoking'],
          },
          confidence: 0.9,
          next_topic: 'done',
        }),
        modelUsed: 'mock',
        latencyMs: 1,
        fallbackUsed: false,
      };
    }
    if (p.includes('THREE first-person interview statements')) {
      return {
        text: JSON.stringify({
          statements: [
            { dimension: 'deen', statement: 'I expect my spouse to pray five times a day.' },
            { dimension: 'family', statement: 'I want to live with my parents after marriage.' },
            { dimension: 'kids', statement: 'I want my first child within two years.' },
          ],
        }),
        modelUsed: 'mock',
        latencyMs: 1,
        fallbackUsed: false,
      };
    }
    if (p.includes('Synthesize the FOUR layers')) {
      return {
        text: JSON.stringify({
          identity: { name: 'Test User', age: 28, gender: 'male', city: 'Karachi' },
          deen_level: 'practicing',
          family_setup: 'nuclear',
          family_loyalty_score: 0.7,
          career: {
            current: 'Software engineer',
            five_yr_goal: 'Senior engineer',
            ambition: 0.7,
          },
          finances: { current_status: 'stable', lifestyle_pref: 'comfortable' },
          kids_timeline: '2-3_yrs',
          conflict_style: 'direct',
          geography: { current_city: 'Karachi', ten_yr_pref: 'Karachi', flexible: true },
          dealbreakers: ['No smoking'],
          dimension_weights: {
            deen: 0.2,
            family: 0.15,
            career: 0.12,
            finances: 0.12,
            kids: 0.12,
            conflict: 0.1,
            geography: 0.07,
            dealbreakers: 0.12,
          },
        }),
        modelUsed: 'mock',
        latencyMs: 1,
        fallbackUsed: false,
      };
    }
    // Twin voice prompt — return a >50 char string of plain text.
    return {
      text:
        'You are Test User, a 28-year-old male from Karachi. You are practicing, direct, family-oriented, ' +
        'career-focused, and clear about your dealbreakers. How I debate: speak in first person, never break character.',
      modelUsed: 'mock',
      latencyMs: 1,
      fallbackUsed: false,
    };
  }),
  geminiSmokeTest: vi.fn(async () => ({ ok: true, modelUsed: 'mock', latencyMs: 1 })),
}));

// Mock the Supabase client so the insert + update calls don't try to reach the
// internet. The trace bus also calls supabase.from('traces').insert internally
// on close — wire that up too.
vi.mock('../src/db/client.js', () => {
  const insertCalls: unknown[] = [];
  const updateCalls: unknown[] = [];

  const builder = (kind: 'insert' | 'update') => {
    return {
      select: (_cols: string) =>
        Promise.resolve({ data: [{ id: 'fake-twin-uuid' }], error: null }),
      eq: (_col: string, _val: string) => Promise.resolve({ data: null, error: null }),
      // Allow direct `await` on the builder (used by trace.close()).
      then: (resolve: (v: { data: null; error: null }) => unknown) =>
        resolve({ data: null, error: null }),
      _kind: kind,
    };
  };

  const fromImpl = (_table: string) => ({
    insert: (row: unknown) => {
      insertCalls.push({ table: _table, row });
      return builder('insert');
    },
    update: (row: unknown) => {
      updateCalls.push({ table: _table, row });
      return builder('update');
    },
    select: (_cols: string, _opts?: unknown) =>
      Promise.resolve({ data: [], error: null, count: 0 }),
    upsert: (_row: unknown) => Promise.resolve({ data: null, error: null }),
  });

  const supabase = {
    from: fromImpl,
    auth: {
      getUser: async (_token: string) => ({ data: { user: { id: 'fake-user' } }, error: null }),
    },
  };

  return {
    supabase,
    supabasePublic: supabase,
    dbWrite: async <T>(_label: string, fn: (sb: typeof supabase) => Promise<{ data: T | null; error: unknown }>) => {
      const r = await fn(supabase);
      if (!r.data) throw new Error('mock dbWrite returned null');
      return r.data;
    },
    dbRead: async () => null,
    healthCheck: async () => ({ ok: true, latencyMs: 1 }),
  };
});

// ---------- Test ----------
import {
  startOnboarding,
  runLayer1,
  runLayer2,
  runLayer3Generate,
  applyLayer3Corrections,
  runLayer4,
  finalizeOnboarding,
} from '../src/workplans/onboarding.workplan.js';
import { TwinSpecSchema } from '../src/domain/twin.js';

describe('onboarding workplan — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('walks all four layers and produces a valid TwinSpec', async () => {
    const t0 = Date.now();

    // --- Layer 1 ---
    const { session, bus } = startOnboarding({ userId: 'fake-user', language: 'en' });
    const turn = await runLayer1({
      session,
      bus,
      text: 'My name is Test User, 28, male, Karachi. I am practicing.',
    });
    expect(turn.confidence).toBeGreaterThan(0.5);
    expect(session.payload.identity?.name).toBe('Test User');

    // --- Layer 2: answer 3 scenario cards ---
    runLayer2({ session, bus, cardId: 'card_salah', optionId: 'a' });
    runLayer2({ session, bus, cardId: 'card_inlaws', optionId: 'a' });
    runLayer2({ session, bus, cardId: 'card_kids_timing', optionId: 'b' });
    expect(session.scenarioResponses).toHaveLength(3);
    expect(session.personalityVector.deen).toBeGreaterThan(0);

    // --- Layer 3: generate + correct ---
    const statements = await runLayer3Generate({ session, bus });
    expect(statements).toHaveLength(3);
    applyLayer3Corrections({
      session,
      bus,
      corrections: [
        { dimension: 'deen', agree: true },
        { dimension: 'family', agree: false, correction: 'Actually flexible on living together' },
      ],
    });

    // --- Layer 4 (wali) with a real conflict ---
    const wali = runLayer4({
      session,
      bus,
      input: {
        wali_phone: '+923331234567',
        override: { deen_level: 'strict' }, // user said practicing → conflict
        notes: 'wali wants stricter deen',
      },
    });
    expect(wali.conflicts.length).toBe(1);
    expect(wali.conflicts[0]?.field).toBe('deen_level');

    // --- Finalize ---
    const final = await finalizeOnboarding({ session, bus });
    expect(final.twinId).toBe('fake-twin-uuid');
    expect(TwinSpecSchema.safeParse(final.spec).success).toBe(true);
    expect(final.spec.identity.name).toBe('Test User');
    expect(final.spec.version).toBe(1);

    // Exit check from SESSION_CONTEXT §4: trace must have ≥15 events.
    expect(final.traceEventCount).toBeGreaterThanOrEqual(15);

    // Exit check: under 2 minutes.
    expect(Date.now() - t0).toBeLessThan(120_000);
  });
});

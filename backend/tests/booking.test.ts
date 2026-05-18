// Booking Agent happy-path test.
// Mocks calendar + maps tools deterministically. proposeSlots is pure
// orchestration on top of those tools — verify it pairs 3 slots × 3 venues
// and emits a clean trace.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/tools/calendar.mock.js', () => ({
  calendarMockFindSlots: vi.fn(async () => ({
    proposed: [
      { slotIso: '2026-05-23T13:00:00.000Z', slotHuman: 'Saturday 23 May, 6:00 PM PKT', dayOfWeek: 'Sat', bothWalisFree: true, userWaliConfidence: 0.95, candidateWaliConfidence: 0.9, rank: 1 },
      { slotIso: '2026-05-24T12:00:00.000Z', slotHuman: 'Sunday 24 May, 5:00 PM PKT', dayOfWeek: 'Sun', bothWalisFree: true, userWaliConfidence: 0.85, candidateWaliConfidence: 0.85, rank: 2 },
      { slotIso: '2026-05-27T14:00:00.000Z', slotHuman: 'Wednesday 27 May, 7:00 PM PKT', dayOfWeek: 'Wed', bothWalisFree: true, userWaliConfidence: 0.75, candidateWaliConfidence: 0.8, rank: 3 },
    ],
    searchedDays: 14,
    rejectedCount: 4,
  })),
}));

vi.mock('../src/tools/maps.js', () => ({
  mapsFindVenue: vi.fn(async () => ({
    venues: [
      { name: 'Cafe Aylanto', address: 'MM Alam Road, Lahore', area: 'MM Alam', city: 'Lahore', rating: 4.5, priceLevel: 2, category: 'cafe', source: 'fallback', placeId: null, mapsUrl: 'https://maps.google.com' },
      { name: 'Butlers Chocolate Cafe', address: 'Gulberg, Lahore', area: 'Gulberg', city: 'Lahore', rating: 4.3, priceLevel: 2, category: 'cafe', source: 'fallback', placeId: null, mapsUrl: 'https://maps.google.com' },
      { name: 'Cafe Zouk', address: 'MM Alam, Lahore', area: 'MM Alam', city: 'Lahore', rating: 4.4, priceLevel: 2, category: 'cafe', source: 'fallback', placeId: null, mapsUrl: 'https://maps.google.com' },
    ],
    usedFallback: true,
    attempts: 0,
  })),
}));

vi.mock('../src/agents/_shared/gemini.js', () => ({
  geminiCall: vi.fn(async () => ({ text: '{}', modelUsed: 'mock', latencyMs: 1, fallbackUsed: false })),
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
import { proposeSlots } from '../src/agents/booking.agent.js';
import { CANDIDATES } from '../src/content/candidates.js';

describe('Booking Agent — proposeSlots happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 3 slot+venue proposals with paired summaries and a clean trace', async () => {
    const bus = startTrace('book_meeting', { flowId: 'booking-test', userId: 'test-user' });

    const out = await proposeSlots(
      {
        userSpec: CANDIDATES[6]!.spec,
        candidateSpec: CANDIDATES[0]!.spec,
        userWaliPhone: '+923001234567',
        candidateWaliPhone: '+923009876543',
        area: 'DHA Phase 6',
      },
      bus
    );

    expect(out.proposals).toHaveLength(3);
    expect(out.proposals[0]?.slot.slotIso.length).toBeGreaterThan(0);
    expect(out.proposals[0]?.venue.name.length).toBeGreaterThan(0);
    expect(out.proposals[0]?.summary).toContain(out.proposals[0]!.venue.name);
    expect(out.proposals.every((p, i) => p.index === i)).toBe(true);
    expect(bus.events().length).toBeGreaterThanOrEqual(4);

    await endTrace(bus, out);
  });
});

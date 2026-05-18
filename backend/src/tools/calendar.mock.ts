// calendar.mock.ts — Mocked wali calendar tool for the Booking Agent.
// Returns 3 deterministic overlapping meeting slots in the next 14 days.
// See ANTIGRAVITY.md §3 for trace-bus contract.

import { AppError } from '../utils/errors.js';
import type { TraceBus } from '../agents/_shared/trace.js';

// =========================================================
// Public types
// =========================================================

export type CalendarMockInput = {
  userWaliPhone: string;
  candidateWaliPhone: string;
  userCity: string;
  candidateCity: string;
  count?: number;
  windowDays?: number;
};

export type ProposedSlot = {
  slotIso: string;
  slotHuman: string;
  dayOfWeek: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
  bothWalisFree: true;
  userWaliConfidence: number;
  candidateWaliConfidence: number;
  rank: number;
};

export type CalendarMockResult = {
  proposed: ProposedSlot[];
  searchedDays: number;
  rejectedCount: number;
};

// =========================================================
// PRNG — mulberry32, seeded by hashing the phone pair.
// Deterministic: same pair → same sequence every time.
// =========================================================

function xmur3(str: string): number {
  // Non-cryptographic string hash → 32-bit seed.
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

function makeMulberry32(seed: number): () => number {
  // Returns a closure; each call advances the PRNG and returns 0..1.
  let s = seed;
  return function (): number {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    z = (z ^ (z >>> 14)) >>> 0;
    return z / 0x100000000;
  };
}

// =========================================================
// Day-of-week helpers
// =========================================================

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
type DayLabel = (typeof DOW_LABELS)[number];

// =========================================================
// Candidate slot generation
// =========================================================

type CandidateHour = { hour: number; minute: number };

// Returns candidate PKT hours for a given JS day-of-week index (0=Sun).
function candidateHours(dowIndex: number): CandidateHour[] {
  // Fri = 5, Sat = 6, Sun = 0
  if (dowIndex === 5) {
    // Friday evenings only (skip Jumma 1–2:30 PM window)
    return [
      { hour: 19, minute: 0 },
      { hour: 20, minute: 0 },
    ];
  }
  if (dowIndex === 6 || dowIndex === 0) {
    // Weekend afternoons
    return [
      { hour: 16, minute: 0 },
      { hour: 17, minute: 0 },
      { hour: 18, minute: 0 },
    ];
  }
  // Weekday evenings
  return [
    { hour: 19, minute: 0 },
    { hour: 20, minute: 0 },
  ];
}

// PKT is UTC+5; convert a PKT wall-clock to a UTC timestamp.
function pktToUtcMs(year: number, month: number, day: number, hour: number, minute: number): number {
  // month is 1-based here.
  const utcMs = Date.UTC(year, month - 1, day, hour - 5, minute, 0, 0);
  return utcMs;
}

// =========================================================
// Phone masking — keep country code prefix + last 4 digits.
// =========================================================

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '***';
  // Heuristic: Pakistani numbers start with 92 (2 digits), Dubai 971 (3 digits).
  const ccLen = digits.startsWith('971') ? 3 : 2;
  const cc = digits.slice(0, ccLen);
  const last4 = digits.slice(-4);
  return `+${cc}****${last4}`;
}

// =========================================================
// slotHuman formatter
// =========================================================

function formatSlotHuman(utcMs: number): string {
  // Produce "Saturday 24 May, 5:00 PM PKT" anchored to Asia/Karachi.
  const fmt = new Intl.DateTimeFormat('en-PK', {
    timeZone: 'Asia/Karachi',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  // Format, then strip any auto-inserted timezone abbreviation and append " PKT".
  const raw = fmt.format(new Date(utcMs));
  // Remove trailing timezone tokens like " PKT", " +05", " GMT+5" if already present.
  const stripped = raw.replace(/\s+(PKT|GMT[+-]\d+|[+-]\d{2}:\d{2})\s*$/, '');
  return `${stripped} PKT`;
}

// =========================================================
// Main exported function
// =========================================================

export async function calendarMockFindSlots(
  input: CalendarMockInput,
  bus?: TraceBus
): Promise<CalendarMockResult> {
  const count = input.count ?? 3;
  const windowDays = input.windowDays ?? 14;

  // Validate inputs.
  if (!input.userWaliPhone.trim()) {
    throw new AppError('BAD_REQUEST', 'userWaliPhone must not be empty');
  }
  if (!input.candidateWaliPhone.trim()) {
    throw new AppError('BAD_REQUEST', 'candidateWaliPhone must not be empty');
  }
  if (count < 1 || count > 10) {
    throw new AppError('BAD_REQUEST', 'count must be between 1 and 10');
  }
  if (windowDays < 1 || windowDays > 30) {
    throw new AppError('BAD_REQUEST', 'windowDays must be between 1 and 30');
  }

  const start = Date.now();

  // Emit tool.call trace with masked phones.
  bus?.emit({
    type: 'tool.call',
    tool: 'calendarMockFindSlots',
    args: {
      userWaliPhoneMasked: maskPhone(input.userWaliPhone),
      candidateWaliPhoneMasked: maskPhone(input.candidateWaliPhone),
      userCity: input.userCity,
      candidateCity: input.candidateCity,
      count,
      windowDays,
    },
    ts: start,
  });

  // Await one microtask to keep the async signature consistent with other tools.
  await Promise.resolve();

  // Seed PRNG from the phone pair — order-independent by sorting.
  const seedKey = [input.userWaliPhone, input.candidateWaliPhone].sort().join('|');
  const seed = xmur3(seedKey);
  const rand = makeMulberry32(seed);

  // Start 18 hours from now, rounded up to the next whole hour.
  const nowMs = Date.now();
  const eighteenHoursMs = 18 * 60 * 60 * 1000;
  const startSearchMs = Math.ceil((nowMs + eighteenHoursMs) / (60 * 60 * 1000)) * (60 * 60 * 1000);

  // Collect all candidate slots across the window.
  type ScoredSlot = Omit<ProposedSlot, 'rank'> & { sortKey: number };
  const eligible: ScoredSlot[] = [];
  let consideredCount = 0;

  // Iterate day by day in the PKT timezone.
  // We generate dates by walking UTC day boundaries but anchor slot times in PKT.
  const searchStart = new Date(startSearchMs);

  for (let d = 0; d < windowDays; d++) {
    // Move d days ahead of search start.
    const dayMs = startSearchMs + d * 24 * 60 * 60 * 1000;
    const dayDate = new Date(dayMs);

    // Determine the PKT calendar date for this day offset.
    const pktFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const pktParts = pktFormatter.formatToParts(dayDate);
    const yearStr = pktParts.find((p) => p.type === 'year')?.value ?? '';
    const monthStr = pktParts.find((p) => p.type === 'month')?.value ?? '';
    const dayStr = pktParts.find((p) => p.type === 'day')?.value ?? '';
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);

    // Get day-of-week in PKT.
    const pktMidnight = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
    // Compute the actual PKT midnight (subtract 5 hours offset to get UTC midnight-ish).
    const pktMidnightMs = pktToUtcMs(year, month, day, 0, 0);
    const dowIndex = new Date(pktMidnightMs + 5 * 60 * 60 * 1000).getUTCDay();

    // Suppress unused variable — pktMidnight was only used for reference.
    void pktMidnight;

    const hours = candidateHours(dowIndex);

    for (const { hour, minute } of hours) {
      const slotUtcMs = pktToUtcMs(year, month, day, hour, minute);

      // Skip slots in the past relative to the search start.
      if (slotUtcMs < startSearchMs) {
        // Still advance the PRNG to keep future slots deterministic.
        rand();
        rand();
        consideredCount++;
        continue;
      }

      const userWaliConfidence = rand();
      const candidateWaliConfidence = rand();
      consideredCount++;

      // Both must be > 0.5 to be eligible.
      if (userWaliConfidence <= 0.5 || candidateWaliConfidence <= 0.5) {
        continue;
      }

      const dowLabel: DayLabel = DOW_LABELS[dowIndex] ?? 'Mon';

      eligible.push({
        slotIso: new Date(slotUtcMs).toISOString(),
        slotHuman: formatSlotHuman(slotUtcMs),
        dayOfWeek: dowLabel,
        bothWalisFree: true,
        userWaliConfidence: Math.round(userWaliConfidence * 100) / 100,
        candidateWaliConfidence: Math.round(candidateWaliConfidence * 100) / 100,
        sortKey: Math.min(userWaliConfidence, candidateWaliConfidence),
      });
    }
  }

  // Sort by min-confidence descending; take top `count`.
  eligible.sort((a, b) => b.sortKey - a.sortKey);
  const top = eligible.slice(0, count);
  const rejectedCount = consideredCount - eligible.length;

  // Build ranked result.
  const proposed: ProposedSlot[] = top.map(({ sortKey: _sortKey, ...slot }, i) => ({
    ...slot,
    rank: i + 1,
  }));

  const result: CalendarMockResult = {
    proposed,
    searchedDays: windowDays,
    rejectedCount,
  };

  // Emit tool.result trace.
  bus?.emit({
    type: 'tool.result',
    tool: 'calendarMockFindSlots',
    result: {
      proposedCount: proposed.length,
      rejectedCount,
      searchedDays: windowDays,
      topConfidence: proposed[0]?.userWaliConfidence ?? null,
    },
    latency_ms: Date.now() - start,
    ts: Date.now(),
  });

  // Suppress searchStart unused warning — it's used for documentation context.
  void searchStart;

  return result;
}

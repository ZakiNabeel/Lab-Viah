// Booking Agent — MASTERPLAN §5.7.
//
// Two entry points:
//   - proposeSlots: produces 3 (slot, venue) pairs for first-meeting workflow.
//     Combines calendarMockFindSlots + mapsFindVenue. Runs in book_meeting
//     workplan step 3-4.
//   - finalizeMeeting: turns one chosen (slot, venue) pair into a final
//     meeting card + reminder schedule. Runs in /book/confirm.
//
// The agent itself does not write to Supabase — the workplan layer owns
// persistence (the meetings row update). The agent owns reasoning + tool
// orchestration + decision logs.
//
// Failure modes per §5.7:
//   - Slot conflict (calendar can't produce 3 eligible slots) → propose
//     fewer + emit recovery event. The workplan still ships the proposal.
//   - Venue unavailable (Maps API down) → the maps tool's own fallback list
//     fires, emits its own recovery event. Nothing extra to do here.

import { decide, obs, recover, taskEnd, taskStart, type TraceBus } from './_shared/trace.js';
import { calendarMockFindSlots, type ProposedSlot } from '../tools/calendar.mock.js';
import { mapsFindVenue, type Venue } from '../tools/maps.js';
import type { TwinSpec } from '../domain/twin.js';

// =========================================================
// Public types
// =========================================================

export type ProposeSlotsInput = {
  userSpec: TwinSpec;
  candidateSpec: TwinSpec;
  userWaliPhone: string;
  candidateWaliPhone: string;
  // Optional: meeting area override (e.g. "DHA Phase 6"). Defaults to the
  // user's city center.
  area?: string;
};

export type SlotProposal = {
  index: number;             // 0..2 — what the wali picks by index.
  slot: ProposedSlot;
  venue: Venue;
  // True when this proposal uses a hardcoded fallback venue (no Maps API).
  venueFromFallback: boolean;
  // Short human-readable summary line ("Saturday 24 May, 5 PM at Cafe Aylanto, MM Alam").
  summary: string;
};

export type ProposeSlotsOutput = {
  proposals: SlotProposal[];
  city: string;
  area: string;
  generatedAt: string;
};

export type FinalizeMeetingInput = {
  meetingId: string;
  chosen: SlotProposal;
  userFirstName: string;
  candidateName: string;
};

export type FinalizeMeetingOutput = {
  meetingId: string;
  slotIso: string;
  slotHuman: string;
  venue: Venue;
  meetingCardUrl: string;     // /meetings/:id/card — rendered by mobile UI.
  reminders: Reminder[];
};

export type Reminder = {
  fireAtIso: string;
  hoursBefore: number;
  channel: 'sms' | 'inapp';
  audience: 'user' | 'wali_user' | 'wali_candidate' | 'candidate';
};

// =========================================================
// Entry point — proposeSlots
// =========================================================

export async function proposeSlots(
  input: ProposeSlotsInput,
  bus: TraceBus
): Promise<ProposeSlotsOutput> {
  const candName = input.candidateSpec.identity.name;
  const userCity = input.userSpec.identity.city;
  const area = input.area ?? defaultAreaFor(userCity);
  const task = `propose_slots:${candName}`;
  taskStart(bus, task);

  obs(bus, 'booking', `proposing 3 (slot, venue) pairs for ${input.userSpec.identity.name} × ${candName} in ${userCity} (${area})`);

  // Run calendar + maps in parallel — no shared state, halves wall-clock.
  const [slotResult, venueResult] = await Promise.all([
    calendarMockFindSlots(
      {
        userWaliPhone: input.userWaliPhone,
        candidateWaliPhone: input.candidateWaliPhone,
        userCity,
        candidateCity: input.candidateSpec.identity.city,
        count: 3,
        windowDays: 14,
      },
      bus
    ),
    mapsFindVenue(
      {
        city: userCity,
        area,
        count: 3,
      },
      bus
    ),
  ]);

  const slots = slotResult.proposed;
  const venues = venueResult.venues;

  // Handle the "calendar couldn't find 3 slots" branch: we ask for 3 but the
  // mock can return fewer in rare seed combinations. Surface as recovery
  // rather than failing the whole booking.
  if (slots.length < 3) {
    recover(
      bus,
      `calendar produced only ${slots.length} eligible slots (wanted 3)`,
      `proceeding with ${slots.length} proposal(s); the wali can request more options`
    );
  }

  // Pair slot[i] with venue[i] — both lists are ranked, so the best slot gets
  // the best venue. If we got fewer venues than slots, recycle the first
  // venue for the trailing slots (the maps tool's fallback path guarantees
  // ≥3 venues so this branch is theoretical, but defensive).
  const proposals: SlotProposal[] = slots.map((slot, i) => {
    const venue = venues[i] ?? venues[0];
    if (!venue) {
      // Programmer error: the maps tool's contract guarantees count results.
      throw new Error('maps tool returned zero venues — fallback path is broken');
    }
    return {
      index: i,
      slot,
      venue,
      venueFromFallback: venue.source === 'fallback',
      summary: `${slot.slotHuman} at ${venue.name}, ${venue.area}`,
    };
  });

  decide(
    bus,
    'booking',
    `${proposals.length} proposal(s) ready for ${candName}`,
    `top slot: ${proposals[0]?.summary ?? '(none)'}; maps fallback=${venueResult.usedFallback}, attempts=${venueResult.attempts}`
  );

  const out: ProposeSlotsOutput = {
    proposals,
    city: userCity,
    area,
    generatedAt: new Date().toISOString(),
  };

  taskEnd(bus, task, {
    proposals: proposals.length,
    topSlot: proposals[0]?.slot.slotHuman ?? null,
    topVenue: proposals[0]?.venue.name ?? null,
    mapsFallback: venueResult.usedFallback,
  });

  return out;
}

// =========================================================
// Entry point — finalizeMeeting
// =========================================================

export async function finalizeMeeting(
  input: FinalizeMeetingInput,
  bus: TraceBus
): Promise<FinalizeMeetingOutput> {
  const task = `finalize_meeting:${input.candidateName}`;
  taskStart(bus, task);

  obs(
    bus,
    'booking',
    `finalizing meeting ${input.meetingId} → slot=${input.chosen.slot.slotHuman}, venue=${input.chosen.venue.name}`
  );

  const reminders = buildReminderSchedule(input.chosen.slot.slotIso);
  const meetingCardUrl = `/meetings/${input.meetingId}/card`;

  decide(
    bus,
    'booking',
    `meeting locked: slot=${input.chosen.slot.slotHuman}, venue=${input.chosen.venue.name}`,
    `${reminders.length} reminder(s) scheduled (24h, 2h, 30min before meeting)`
  );

  const out: FinalizeMeetingOutput = {
    meetingId: input.meetingId,
    slotIso: input.chosen.slot.slotIso,
    slotHuman: input.chosen.slot.slotHuman,
    venue: input.chosen.venue,
    meetingCardUrl,
    reminders,
  };

  taskEnd(bus, task, {
    slotIso: out.slotIso,
    venueName: out.venue.name,
    venueSource: out.venue.source,
    reminderCount: reminders.length,
  });

  return out;
}

// =========================================================
// Helpers
// =========================================================

function buildReminderSchedule(slotIso: string): Reminder[] {
  const slotMs = Date.parse(slotIso);
  if (!Number.isFinite(slotMs)) return [];
  const at = (hoursBefore: number, audience: Reminder['audience']): Reminder => ({
    fireAtIso: new Date(slotMs - hoursBefore * 3600_000).toISOString(),
    hoursBefore,
    channel: 'sms',
    audience,
  });
  return [
    at(24, 'wali_user'),
    at(24, 'wali_candidate'),
    at(2, 'user'),
    at(2, 'candidate'),
    at(0.5, 'wali_user'),
  ];
}

function defaultAreaFor(city: string): string {
  const map: Record<string, string> = {
    Karachi: 'DHA Phase 6',
    Lahore: 'Gulberg',
    Islamabad: 'F-7',
    Multan: 'Cantt',
    Dubai: 'Downtown',
  };
  return map[city] ?? 'city center';
}

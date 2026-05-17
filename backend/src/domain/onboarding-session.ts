// In-memory session state for the multi-call onboarding workplan.
//
// Why in-memory: the workplan spans 5 HTTP calls (layer1..wali..finalize) but
// is logically ONE trace per the ANTIGRAVITY.md §2.1 contract. We key both the
// trace bus and the partial-answers state by sessionId (= flowId). If the
// server restarts mid-onboarding the user starts over — acceptable for the
// hackathon. A future iteration would persist this to a `onboarding_sessions`
// table; deferred per MASTERPLAN §13 ("no half-finished" rule).

import { randomUUID } from 'node:crypto';
import type { Dimension } from './dimensions.js';
import type { LanguagePref } from './twin.js';

export type OnboardingFieldConfidence = {
  value: unknown;
  confidence: number; // 0..1
};

export type OnboardingPayload = {
  identity?: { name?: string; age?: number; gender?: 'male' | 'female'; city?: string };
  deen_level?: string;
  family_setup?: string;
  career?: { current?: string; five_yr_goal?: string };
  finances?: { current_status?: string; lifestyle_pref?: string };
  kids_timeline?: string;
  conflict_style?: string;
  geography?: { current_city?: string; ten_yr_pref?: string; flexible?: boolean };
  dealbreakers?: string[];
  language_pref?: LanguagePref;
  per_field_confidence?: Record<string, number>;
};

export type ScenarioResponse = {
  cardId: string;
  optionId: string;
};

export type TwinStatement = {
  dimension: Dimension;
  statement: string;
  agree: boolean | null; // null = not yet answered
  correction?: string;
};

export type WaliInput = {
  // Wali's view of the user's situation. Free-form keys, must be valid TwinSpec subset.
  override: Partial<{
    deen_level: string;
    family_setup: string;
    kids_timeline: string;
    dealbreakers: string[];
  }>;
  wali_phone: string;
  notes?: string;
};

export type ConflictFlag = {
  field: string;
  user_value: unknown;
  wali_value: unknown;
};

export type OnboardingSession = {
  sessionId: string;
  userId: string;
  language: LanguagePref;
  layer1Turns: number;
  payload: OnboardingPayload;
  scenarioResponses: ScenarioResponse[];
  personalityVector: Partial<Record<Dimension, number>>;
  twinStatements: TwinStatement[];
  waliInput?: WaliInput;
  waliConflicts: ConflictFlag[];
  createdAt: number;
  lastTouched: number;
};

const SESSIONS = new Map<string, OnboardingSession>();
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 min — exceeds MASTERPLAN §8.1's 11-min budget.

export function createSession(opts: {
  userId: string;
  language: LanguagePref;
}): OnboardingSession {
  reapStale();
  const sessionId = `ob_${randomUUID()}`;
  const now = Date.now();
  const session: OnboardingSession = {
    sessionId,
    userId: opts.userId,
    language: opts.language,
    layer1Turns: 0,
    payload: { language_pref: opts.language, per_field_confidence: {} },
    scenarioResponses: [],
    personalityVector: {},
    twinStatements: [],
    waliConflicts: [],
    createdAt: now,
    lastTouched: now,
  };
  SESSIONS.set(sessionId, session);
  return session;
}

export function getSession(sessionId: string): OnboardingSession | undefined {
  const s = SESSIONS.get(sessionId);
  if (!s) return undefined;
  if (Date.now() - s.lastTouched > SESSION_TTL_MS) {
    SESSIONS.delete(sessionId);
    return undefined;
  }
  s.lastTouched = Date.now();
  return s;
}

export function dropSession(sessionId: string): void {
  SESSIONS.delete(sessionId);
}

function reapStale(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of SESSIONS) {
    if (s.lastTouched < cutoff) SESSIONS.delete(id);
  }
}

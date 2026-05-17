// Prescreen — MASTERPLAN §8.2 step 2.
//
// Reduces N candidate Twins → top K (K=5) by value-similarity, BEFORE the
// expensive Moderator-orchestrated debate runs. Two cheap filters apply first
// (gender, self-match), then a hand-built 18-dim feature vector + cosine
// similarity, then a per-candidate dealbreaker overlap PENALTY so a candidate
// whose stated values overtly trip a user dealbreaker drops in rank.
//
// Why not a real semantic embedding (the pgvector column)? At hackathon scale
// we have 12 candidates total. A 1.5kb Gemini embedding call per candidate per
// user would burn quota for no signal — our feature space is the spec itself.
// The schema's `embedding` column stays NULL for now; Session 5 polish can
// hydrate it lazily if Sessions 4-5 need semantic recall (e.g. matching on
// free-text dealbreakers).

import { logger } from '../utils/logger.js';
import type { TwinSpec } from './twin.js';

// =========================================================
// Feature extraction
// =========================================================
// 18 normalized features in [0..1] (or [-1..1] for signed) drawn from the
// structured TwinSpec fields. Indexes are stable — do not reorder; the cosine
// math depends on user[i] aligning with candidate[i].

const FEATURE_KEYS = [
  'deen_ordinal',
  'family_joint',
  'family_nuclear',
  'family_single',
  'family_loyalty',
  'career_ambition',
  'finance_status',
  'lifestyle_pref',
  'kids_ordinal',
  'conflict_avoidant',
  'conflict_direct',
  'conflict_consensus',
  'conflict_elder',
  'geo_flexible',
  'geo_intl_pref',
  'weight_deen',
  'weight_family',
  'weight_career',
] as const;

type FeatureKey = (typeof FEATURE_KEYS)[number];
type FeatureVector = Record<FeatureKey, number>;

const DEEN_RANK: Record<TwinSpec['deen_level'], number> = {
  secular: 0,
  cultural: 0.25,
  moderate: 0.5,
  practicing: 0.75,
  strict: 1,
};

const KIDS_RANK: Record<TwinSpec['kids_timeline'], number> = {
  asap: 1,
  '2-3_yrs': 0.66,
  '5_plus': 0.33,
  none: 0,
};

const FINANCE_RANK: Record<TwinSpec['finances']['current_status'], number> = {
  student: 0,
  starting: 0.33,
  stable: 0.66,
  affluent: 1,
};

const LIFESTYLE_RANK: Record<TwinSpec['finances']['lifestyle_pref'], number> = {
  simple: 0,
  comfortable: 0.5,
  aspirational: 1,
};

// Cities that are roughly "international" (signal: spouse must accept moving
// or living abroad). Kept tiny on purpose — this is a cheap heuristic, not
// geocoding.
const INTERNATIONAL_CITIES = new Set([
  'dubai',
  'abu dhabi',
  'london',
  'toronto',
  'new york',
  'doha',
  'riyadh',
  'jeddah',
]);

function featurize(spec: TwinSpec): FeatureVector {
  const family = spec.family_setup;
  const conflict = spec.conflict_style;
  const tenYrCity = spec.geography.ten_yr_pref.toLowerCase();
  const intlPref = INTERNATIONAL_CITIES.has(tenYrCity) ? 1 : 0;

  return {
    deen_ordinal: DEEN_RANK[spec.deen_level],
    family_joint: family === 'joint' ? 1 : 0,
    family_nuclear: family === 'nuclear' ? 1 : 0,
    family_single: family === 'single_parent' ? 1 : 0,
    family_loyalty: spec.family_loyalty_score,
    career_ambition: spec.career.ambition,
    finance_status: FINANCE_RANK[spec.finances.current_status],
    lifestyle_pref: LIFESTYLE_RANK[spec.finances.lifestyle_pref],
    kids_ordinal: KIDS_RANK[spec.kids_timeline],
    conflict_avoidant: conflict === 'avoidant' ? 1 : 0,
    conflict_direct: conflict === 'direct' ? 1 : 0,
    conflict_consensus: conflict === 'consensus' ? 1 : 0,
    conflict_elder: conflict === 'elder_mediated' ? 1 : 0,
    geo_flexible: spec.geography.flexible ? 1 : 0,
    geo_intl_pref: intlPref,
    // The user's dimension_weights tell us what THEY care about; we mirror
    // the top three weights into the feature space so candidates aligned on
    // the user's priorities rank higher. Symmetric per the candidate's own
    // weights — cosine will reward weight-overlap as well.
    weight_deen: spec.dimension_weights.deen,
    weight_family: spec.dimension_weights.family,
    weight_career: spec.dimension_weights.career,
  };
}

function vectorize(v: FeatureVector): number[] {
  return FEATURE_KEYS.map((k) => v[k]);
}

// =========================================================
// Cosine similarity
// =========================================================

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Feature length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// =========================================================
// Dealbreaker overlap penalty
// =========================================================
// String-overlap between the user's dealbreakers and the candidate's spec.
// Cheap, intentionally fuzzy — the real check happens during the Moderator
// debate. This just prevents an obviously-incompatible candidate from
// occupying a top-5 slot.

const DEALBREAKER_KEYWORDS: { keyword: RegExp; specCheck: (s: TwinSpec) => boolean }[] = [
  {
    keyword: /no\s+smok/i,
    specCheck: (s) => s.dealbreakers.some((d) => /smok/i.test(d)) === false && /smok/i.test(s.system_prompt) === true,
  },
  {
    keyword: /must\s+be\s+practicing|spouse\s+must\s+be\s+practicing|must\s+be\s+religious/i,
    specCheck: (s) => s.deen_level === 'secular' || s.deen_level === 'cultural',
  },
  {
    keyword: /no\s+prior|no\s+past|no\s+previous/i,
    specCheck: (s) =>
      s.dealbreakers.some((d) => /prior|past|previous/i.test(d)) && /prior|previous|past relationship/i.test(s.system_prompt),
  },
  {
    keyword: /no\s+joint\s+family|no\s+in-?law\s+co-?residence/i,
    specCheck: (s) => s.family_setup === 'joint' && s.family_loyalty_score > 0.7,
  },
  {
    keyword: /must\s+stay\s+in\s+([a-z]+)|must\s+remain\s+in\s+([a-z]+)/i,
    specCheck: (_s) => false, // matched at runtime against city — handled below.
  },
];

function dealbreakerPenalty(userSpec: TwinSpec, candidateSpec: TwinSpec): number {
  let penalty = 0;
  for (const db of userSpec.dealbreakers) {
    for (const rule of DEALBREAKER_KEYWORDS) {
      if (rule.keyword.test(db) && rule.specCheck(candidateSpec)) {
        penalty += 0.2;
      }
    }
    // City-stay rule: "must accept living in <city>" or "no moving from <city>".
    const cityMatch = /(?:stay|remain|live|moving from)\s+in?\s+([A-Za-z]+)/i.exec(db);
    if (cityMatch?.[1]) {
      const city = cityMatch[1].toLowerCase();
      if (
        candidateSpec.geography.current_city.toLowerCase() !== city &&
        candidateSpec.geography.ten_yr_pref.toLowerCase() !== city &&
        !candidateSpec.geography.flexible
      ) {
        penalty += 0.2;
      }
    }
  }
  // Symmetric: candidate's own dealbreakers about the user. The user's
  // structured fields are easier to assert against — e.g. candidate says
  // "must move to Karachi" but user is geography.flexible=false in another
  // city.
  for (const db of candidateSpec.dealbreakers) {
    if (/return(ing)?\s+to|move\s+to\s+pakistan|relocate/i.test(db)) {
      if (!userSpec.geography.flexible) penalty += 0.1;
    }
  }
  return Math.min(0.8, penalty);
}

// =========================================================
// Public API
// =========================================================

export type PrescreenInput = {
  user: TwinSpec;
  candidates: { id: string; spec: TwinSpec }[];
  k?: number;
};

export type PrescreenedCandidate = {
  id: string;
  spec: TwinSpec;
  similarity: number;
  dealbreakerPenalty: number;
  finalScore: number;
};

export function prescreen(input: PrescreenInput): PrescreenedCandidate[] {
  const k = input.k ?? 5;
  const userVec = vectorize(featurize(input.user));
  const userGender = input.user.identity.gender;

  // Gender filter — heterosexual rishta matching. MASTERPLAN §1 / §6.2.
  const opposite = userGender === 'male' ? 'female' : 'male';
  const eligible = input.candidates.filter((c) => c.spec.identity.gender === opposite);

  if (eligible.length === 0) {
    logger.warn(
      { userGender, candidates: input.candidates.length },
      'prescreen: no eligible candidates after gender filter'
    );
    return [];
  }

  const scored: PrescreenedCandidate[] = eligible.map((c) => {
    const candVec = vectorize(featurize(c.spec));
    const sim = cosine(userVec, candVec);
    const pen = dealbreakerPenalty(input.user, c.spec);
    return {
      id: c.id,
      spec: c.spec,
      similarity: sim,
      dealbreakerPenalty: pen,
      finalScore: Math.max(0, sim - pen),
    };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored.slice(0, k);
}

// Exported for testing the feature space without the full prescreen flow.
export const _internals = { featurize, vectorize, cosine, dealbreakerPenalty };

// Per-dimension metadata. The canonical DIMENSIONS list lives in
// `src/agents/_shared/types.ts` (single source of truth for the trace contract).
// This file adds the human-readable labels and the default weight distribution
// used when a user hasn't yet stated their own dimension priorities.

import { DIMENSIONS, type Dimension } from '../agents/_shared/types.js';

export type DimensionMeta = {
  key: Dimension;
  label: string;
  description: string;
  defaultWeight: number;
};

export const DIMENSION_META: Record<Dimension, DimensionMeta> = {
  deen: {
    key: 'deen',
    label: 'Deen practice',
    description: 'Shared deen practice and rigor',
    defaultWeight: 0.18,
  },
  family: {
    key: 'family',
    label: 'Family dynamics',
    description: 'Family dynamics and in-law expectations',
    defaultWeight: 0.14,
  },
  career: {
    key: 'career',
    label: 'Career',
    description: 'Career trajectory and ambition match',
    defaultWeight: 0.12,
  },
  finances: {
    key: 'finances',
    label: 'Finances',
    description: 'Financial outlook and lifestyle expectation',
    defaultWeight: 0.12,
  },
  kids: {
    key: 'kids',
    label: 'Kids',
    description: 'Timing and parenting philosophy',
    defaultWeight: 0.12,
  },
  conflict: {
    key: 'conflict',
    label: 'Conflict style',
    description: 'Disagreement and resolution style',
    defaultWeight: 0.1,
  },
  geography: {
    key: 'geography',
    label: 'Geography',
    description: 'Current city and 10-year preference',
    defaultWeight: 0.1,
  },
  dealbreakers: {
    key: 'dealbreakers',
    label: 'Dealbreakers',
    description: 'Explicit non-negotiables',
    defaultWeight: 0.12,
  },
};

// Sanity: weights sum to 1.0 (within float tolerance). Throws at import time
// if anyone edits DIMENSION_META above and forgets to rebalance.
const WEIGHT_SUM = Object.values(DIMENSION_META).reduce((a, m) => a + m.defaultWeight, 0);
if (Math.abs(WEIGHT_SUM - 1) > 1e-6) {
  throw new Error(
    `DIMENSION_META default weights must sum to 1.0, got ${WEIGHT_SUM.toFixed(6)}`
  );
}

export function defaultWeights(): Record<Dimension, number> {
  const out = {} as Record<Dimension, number>;
  for (const d of DIMENSIONS) out[d] = DIMENSION_META[d].defaultWeight;
  return out;
}

export { DIMENSIONS };
export type { Dimension };

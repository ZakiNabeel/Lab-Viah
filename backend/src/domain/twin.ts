// Twin spec — MASTERPLAN §6.2.
// Authoritative TypeScript type + matching Zod schema. Every Twin write goes
// through TwinSpecSchema.parse() before it touches Supabase.

import { z } from 'zod';
import { DIMENSIONS } from './dimensions.js';

export type Gender = 'male' | 'female';
export type DeenLevel = 'strict' | 'practicing' | 'moderate' | 'cultural' | 'secular';
export type FamilySetup = 'joint' | 'nuclear' | 'single_parent';
export type FinancialStatus = 'student' | 'starting' | 'stable' | 'affluent';
export type LifestylePref = 'simple' | 'comfortable' | 'aspirational';
export type KidsTimeline = 'asap' | '2-3_yrs' | '5_plus' | 'none';
export type ConflictStyle = 'avoidant' | 'direct' | 'consensus' | 'elder_mediated';
export type LanguagePref = 'ur' | 'ro_ur' | 'en';

const IdentitySchema = z.object({
  name: z.string().min(1).max(80),
  age: z.number().int().min(18).max(80),
  gender: z.enum(['male', 'female']),
  city: z.string().min(1).max(80),
});

const CareerSchema = z.object({
  current: z.string().min(1).max(120),
  five_yr_goal: z.string().min(1).max(200),
  ambition: z.number().min(0).max(1),
});

const FinancesSchema = z.object({
  current_status: z.enum(['student', 'starting', 'stable', 'affluent']),
  lifestyle_pref: z.enum(['simple', 'comfortable', 'aspirational']),
});

const GeographySchema = z.object({
  current_city: z.string().min(1).max(80),
  ten_yr_pref: z.string().min(1).max(80),
  flexible: z.boolean(),
});

// Build the dimension_weights schema from the canonical DIMENSIONS list so it
// stays in lock-step with the trace types if a dimension is ever added/removed.
const DimensionWeightsSchema = z.object(
  Object.fromEntries(DIMENSIONS.map((d) => [d, z.number().min(0).max(1)])) as Record<
    (typeof DIMENSIONS)[number],
    z.ZodNumber
  >
);

export const TwinSpecSchema: z.ZodType<TwinSpec> = z.lazy(() =>
  z.object({
    identity: IdentitySchema,
    deen_level: z.enum(['strict', 'practicing', 'moderate', 'cultural', 'secular']),
    family_setup: z.enum(['joint', 'nuclear', 'single_parent']),
    family_loyalty_score: z.number().min(0).max(1),
    career: CareerSchema,
    finances: FinancesSchema,
    kids_timeline: z.enum(['asap', '2-3_yrs', '5_plus', 'none']),
    conflict_style: z.enum(['avoidant', 'direct', 'consensus', 'elder_mediated']),
    geography: GeographySchema,
    dealbreakers: z.array(z.string().min(1).max(120)).max(20),
    dimension_weights: DimensionWeightsSchema,
    system_prompt: z.string().min(50).max(8000),
    wali_override: z.record(z.unknown()).optional(),
    language_pref: z.enum(['ur', 'ro_ur', 'en']),
    version: z.number().int().min(1),
  })
);

export type TwinSpec = {
  identity: { name: string; age: number; gender: Gender; city: string };
  deen_level: DeenLevel;
  family_setup: FamilySetup;
  family_loyalty_score: number;
  career: { current: string; five_yr_goal: string; ambition: number };
  finances: { current_status: FinancialStatus; lifestyle_pref: LifestylePref };
  kids_timeline: KidsTimeline;
  conflict_style: ConflictStyle;
  geography: { current_city: string; ten_yr_pref: string; flexible: boolean };
  dealbreakers: string[];
  dimension_weights: Record<(typeof DIMENSIONS)[number], number>;
  system_prompt: string;
  wali_override?: Record<string, unknown>;
  language_pref: LanguagePref;
  version: number;
};

// Twin Forge Agent — MASTERPLAN §5.2.
//
// Three entry points (one per phase):
//   - generateLayer3Statements: produce 3 first-person statements for the user
//     to confirm/correct (Layer 3 interview).
//   - reconcileWaliConflicts: compare Layer-4 wali_input against Layer-1 user
//     payload and flag conflicts without auto-resolving (per §5.2 failure
//     mode: "Conflicting Wali vs user input → flag for reconciliation, don't
//     auto-resolve").
//   - forgeTwin: final synthesis — produce a complete TwinSpec including the
//     ~400-word voice/system_prompt.

import { z } from 'zod';
import { geminiCall } from './_shared/gemini.js';
import { decide, obs, recover, type TraceBus } from './_shared/trace.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import {
  buildTwinStatementsPrompt,
  buildTwinSpecPrompt,
  buildTwinVoicePrompt,
} from '../content/prompts/twin-system.prompt.js';
import { TwinSpecSchema, type TwinSpec } from '../domain/twin.js';
import { DIMENSIONS, defaultWeights, type Dimension } from '../domain/dimensions.js';
import type {
  ConflictFlag,
  OnboardingSession,
  TwinStatement,
} from '../domain/onboarding-session.js';

// =========================================================
// 1. Layer 3 — interview statements
// =========================================================

const StatementsSchema = z.object({
  statements: z
    .array(
      z.object({
        dimension: z.enum(DIMENSIONS),
        statement: z.string().min(8).max(280),
      })
    )
    .length(3),
});

export async function generateLayer3Statements(
  session: OnboardingSession,
  bus: TraceBus
): Promise<TwinStatement[]> {
  obs(bus, 'twin_forge', 'generating 3 Layer-3 interview statements from payload + personality vector');

  const gem = await geminiCall(
    {
      prompt: buildTwinStatementsPrompt(session),
      temperature: 0.6,
      maxOutputTokens: 768,
      responseFormat: 'json',
    },
    bus
  );

  let parsed: z.infer<typeof StatementsSchema>;
  try {
    parsed = StatementsSchema.parse(JSON.parse(gem.text));
  } catch (err) {
    logger.warn({ err, raw: gem.text.slice(0, 400) }, 'twin_forge: statements failed schema');
    recover(
      bus,
      'malformed Layer-3 JSON from Gemini',
      'falling back to default statements drawn from personality vector'
    );
    return fallbackStatements(session);
  }

  decide(
    bus,
    'twin_forge',
    `generated 3 statements across dimensions: ${parsed.statements.map((s) => s.dimension).join(', ')}`,
    'picked top-signal dimensions from personality vector'
  );

  return parsed.statements.map((s) => ({
    dimension: s.dimension,
    statement: s.statement,
    agree: null,
  }));
}

// Fallback when Gemini gives us junk: deterministic statements over the
// strongest 3 dimensions in the personality vector.
function fallbackStatements(session: OnboardingSession): TwinStatement[] {
  const ranked = (Object.entries(session.personalityVector) as [Dimension, number][])
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const picks: Dimension[] = ranked.slice(0, 3).map(([d]) => d);
  while (picks.length < 3) {
    const next = DIMENSIONS.find((d) => !picks.includes(d));
    if (!next) break;
    picks.push(next);
  }
  return picks.map((d) => ({
    dimension: d,
    statement: defaultStatementFor(d),
    agree: null,
  }));
}

function defaultStatementFor(d: Dimension): string {
  const map: Record<Dimension, string> = {
    deen: 'I would expect my spouse to pray five times a day from the start of our marriage.',
    family: 'After marriage, living with in-laws is the right default — not the exception.',
    career: 'A spouse who is the best in their field matters more to me than a relaxed home life.',
    finances: 'I would rather save aggressively for ten years than upgrade our lifestyle now.',
    kids: 'I want to have children within the first two years of marriage.',
    conflict: 'When we disagree, we settle it the same night — never sleep on a fight.',
    geography: 'I would rule out moving abroad even for a much better job.',
    dealbreakers: 'I would not consider a match with any past public relationship.',
  };
  return map[d];
}

// =========================================================
// 2. Layer 4 — wali / user reconciliation
// =========================================================

export function reconcileWaliConflicts(session: OnboardingSession, bus: TraceBus): ConflictFlag[] {
  if (!session.waliInput) {
    obs(bus, 'twin_forge', 'no wali input provided; skipping reconciliation');
    return [];
  }

  obs(bus, 'twin_forge', 'reconciling wali overrides against user payload');
  const conflicts: ConflictFlag[] = [];
  const o = session.waliInput.override;
  const p = session.payload;

  if (o.deen_level && p.deen_level && o.deen_level !== p.deen_level) {
    conflicts.push({ field: 'deen_level', user_value: p.deen_level, wali_value: o.deen_level });
  }
  if (o.family_setup && p.family_setup && o.family_setup !== p.family_setup) {
    conflicts.push({ field: 'family_setup', user_value: p.family_setup, wali_value: o.family_setup });
  }
  if (o.kids_timeline && p.kids_timeline && o.kids_timeline !== p.kids_timeline) {
    conflicts.push({ field: 'kids_timeline', user_value: p.kids_timeline, wali_value: o.kids_timeline });
  }
  if (o.dealbreakers && o.dealbreakers.length > 0) {
    const userSet = new Set(p.dealbreakers ?? []);
    const extra = o.dealbreakers.filter((d) => !userSet.has(d));
    if (extra.length > 0) {
      conflicts.push({ field: 'dealbreakers', user_value: p.dealbreakers ?? [], wali_value: extra });
    }
  }

  if (conflicts.length > 0) {
    decide(
      bus,
      'twin_forge',
      `flagged ${conflicts.length} wali/user conflict(s); not auto-resolving`,
      'MASTERPLAN §5.2 — wali conflicts are surfaced, never silently resolved; they propagate to dealbreakers verbatim'
    );
  } else {
    obs(bus, 'twin_forge', 'no wali/user conflicts found');
  }

  return conflicts;
}

// =========================================================
// 3. Final synthesis — full TwinSpec
// =========================================================

// Loose schema for the spec body Gemini returns; we then attach version +
// system_prompt locally (those are computed, not Gemini-authored).
const SpecBodySchema = z.object({
  identity: z.object({
    name: z.string().min(1),
    age: z.number().int(),
    gender: z.enum(['male', 'female']),
    city: z.string().min(1),
  }),
  deen_level: z.enum(['strict', 'practicing', 'moderate', 'cultural', 'secular']),
  family_setup: z.enum(['joint', 'nuclear', 'single_parent']),
  family_loyalty_score: z.number().min(0).max(1),
  career: z.object({
    current: z.string().min(1),
    five_yr_goal: z.string().min(1),
    ambition: z.number().min(0).max(1),
  }),
  finances: z.object({
    current_status: z.enum(['student', 'starting', 'stable', 'affluent']),
    lifestyle_pref: z.enum(['simple', 'comfortable', 'aspirational']),
  }),
  kids_timeline: z.enum(['asap', '2-3_yrs', '5_plus', 'none']),
  conflict_style: z.enum(['avoidant', 'direct', 'consensus', 'elder_mediated']),
  geography: z.object({
    current_city: z.string().min(1),
    ten_yr_pref: z.string().min(1),
    flexible: z.boolean(),
  }),
  dealbreakers: z.array(z.string()),
  dimension_weights: z.object(
    Object.fromEntries(DIMENSIONS.map((d) => [d, z.number().min(0).max(1)])) as Record<
      Dimension,
      z.ZodNumber
    >
  ),
});

export async function forgeTwin(session: OnboardingSession, bus: TraceBus): Promise<TwinSpec> {
  obs(bus, 'twin_forge', 'synthesizing TwinSpec from 4 layers');

  // Step 1 — body via Gemini.
  const gem = await geminiCall(
    {
      prompt: buildTwinSpecPrompt(session),
      temperature: 0.3,
      maxOutputTokens: 1500,
      responseFormat: 'json',
    },
    bus
  );

  let body: z.infer<typeof SpecBodySchema>;
  try {
    body = SpecBodySchema.parse(JSON.parse(gem.text));
  } catch (err) {
    logger.warn({ err, raw: gem.text.slice(0, 800) }, 'twin_forge: spec body failed schema');
    recover(
      bus,
      'malformed final TwinSpec JSON from Gemini',
      'rebuilding spec deterministically from payload + vector defaults'
    );
    body = fallbackSpecBody(session);
  }

  // Normalize weights so they sum to 1.0 (Gemini sometimes drifts ±0.05).
  body.dimension_weights = normalizeWeights(body.dimension_weights);

  // Step 2 — author the ~400-word voice/system_prompt locally so we can retry
  // it independently if Gemini fails this leg.
  let systemPrompt: string;
  try {
    const voiceGem = await geminiCall(
      {
        prompt: buildTwinVoicePrompt({ ...body, dealbreakers: body.dealbreakers, language_pref: session.language }),
        temperature: 0.7,
        maxOutputTokens: 900,
      },
      bus
    );
    systemPrompt = voiceGem.text.trim();
    if (systemPrompt.length < 50) {
      throw new AppError('UPSTREAM_FAILURE', 'voice prompt was too short to be useful');
    }
  } catch (err) {
    logger.warn({ err }, 'twin_forge: voice prompt generation failed');
    recover(
      bus,
      'voice prompt generation failed',
      'falling back to a deterministic system_prompt derived from spec body'
    );
    systemPrompt = fallbackSystemPrompt(body);
  }

  const spec: TwinSpec = {
    ...body,
    system_prompt: systemPrompt,
    language_pref: session.language,
    version: 1,
    ...(session.waliInput ? { wali_override: { ...session.waliInput.override } } : {}),
  };

  // Final hard validation. If this throws, we have a programming error, not
  // a model error — surface immediately.
  const validated = TwinSpecSchema.parse(spec);

  decide(
    bus,
    'twin_forge',
    `forged TwinSpec v1 for ${validated.identity.name}`,
    `dimensions weighted toward ${topDimensions(validated.dimension_weights, 2).join(' + ')}; ${validated.dealbreakers.length} dealbreaker(s)`
  );

  return validated;
}

function normalizeWeights(w: Record<Dimension, number>): Record<Dimension, number> {
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (sum === 0) return defaultWeights();
  const out = {} as Record<Dimension, number>;
  for (const d of DIMENSIONS) out[d] = (w[d] ?? 0) / sum;
  return out;
}

function topDimensions(w: Record<Dimension, number>, k: number): Dimension[] {
  return (Object.entries(w) as [Dimension, number][])
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([d]) => d);
}

function fallbackSpecBody(session: OnboardingSession): z.infer<typeof SpecBodySchema> {
  const p = session.payload;
  const i = p.identity ?? {};
  return {
    identity: {
      name: i.name ?? 'Unknown',
      age: i.age ?? 28,
      gender: (i.gender as 'male' | 'female') ?? 'male',
      city: i.city ?? 'Karachi',
    },
    deen_level: (p.deen_level as 'practicing') ?? 'practicing',
    family_setup: (p.family_setup as 'nuclear') ?? 'nuclear',
    family_loyalty_score: 0.6,
    career: {
      current: p.career?.current ?? 'Professional',
      five_yr_goal: p.career?.five_yr_goal ?? 'Senior in current field',
      ambition: 0.6,
    },
    finances: { current_status: 'stable', lifestyle_pref: 'comfortable' },
    kids_timeline: (p.kids_timeline as '2-3_yrs') ?? '2-3_yrs',
    conflict_style: 'direct',
    geography: {
      current_city: p.geography?.current_city ?? i.city ?? 'Karachi',
      ten_yr_pref: p.geography?.ten_yr_pref ?? i.city ?? 'Karachi',
      flexible: p.geography?.flexible ?? true,
    },
    dealbreakers: p.dealbreakers ?? [],
    dimension_weights: defaultWeights(),
  };
}

function fallbackSystemPrompt(body: z.infer<typeof SpecBodySchema>): string {
  const i = body.identity;
  return (
    `You are ${i.name}, a ${i.age}-year-old ${i.gender} from ${i.city}. ` +
    `Your deen level is ${body.deen_level}; you come from a ${body.family_setup} family setup ` +
    `with a family loyalty score of ${body.family_loyalty_score.toFixed(2)}. ` +
    `Career: ${body.career.current}; five-year goal: ${body.career.five_yr_goal} (ambition ${body.career.ambition.toFixed(2)}). ` +
    `Finances: ${body.finances.current_status} status with a ${body.finances.lifestyle_pref} lifestyle preference. ` +
    `Kids timeline: ${body.kids_timeline}. Conflict style: ${body.conflict_style}. ` +
    `Geography: currently in ${body.geography.current_city}, ten-year preference is ${body.geography.ten_yr_pref} (flexible=${body.geography.flexible}). ` +
    `Hard limits — these are non-negotiable: ${body.dealbreakers.join('; ') || 'none stated'}. ` +
    `How I debate: speak in first person, never break character, and call out dealbreaker hits immediately and clearly. ` +
    `Be specific. Avoid platitudes. If a question doesn't apply to me, say so plainly rather than make something up.`
  );
}

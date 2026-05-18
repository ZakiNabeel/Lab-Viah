// Dispute Agent — MASTERPLAN §5.8.
//
// Single entry point: runDisputeAgent. Calls Gemini Pro in JSON mode to
// produce a structured DisputeResolution. On parse failure, falls back to
// fallbackResolution() from the prompt file and emits a recover event.
//
// Visible recovery moment (required by hackathon spec): when Gemini produces
// escalated=true and action="flag_for_human_review" (contradictory accounts),
// the agent emits BOTH a decide event AND a recover event. This makes the
// escalation path explicit in the trace for demo auditing.

import { z } from 'zod';
import { geminiCall } from './_shared/gemini.js';
import { decide, obs, recover, taskEnd, taskStart, type TraceBus } from './_shared/trace.js';
import { logger } from '../utils/logger.js';
import {
  buildDisputePrompt,
  fallbackResolution,
  type DisputeAction,
  type DisputePromptArgs,
  type DisputeResolution,
  type DisputeType,
} from '../content/prompts/dispute.prompt.js';
import type { TwinSpec } from '../domain/twin.js';

// =========================================================
// Zod schema — mirrors DisputeResolution exactly
// =========================================================

const DisputeTypeSchema = z.enum([
  'no_show',
  'misrepresentation',
  'ghosting',
  'family_rejection',
  'other',
]);

const DisputeActionSchema = z.enum([
  'no_action',
  'warning',
  'shadowban',
  'flag_for_human_review',
  'mutual_close',
]);

const SeveritySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

const ReputationImpactSchema = z.array(
  z.object({
    party: z.enum(['filer', 'counterparty']),
    delta: z.number().max(0),
    reason: z.string().min(1).max(300),
  })
);

const BlocklistChangeSchema = z.array(
  z.object({
    party: z.enum(['filer', 'counterparty']),
    blockedTwinId: z.string().min(1),
  })
);

const OutreachSchema = z.array(
  z.object({
    toRole: z.enum(['user', 'wali_user', 'counterparty']),
    messageKey: z.enum(['filed', 'resolved']),
  })
);

const DisputeResolutionSchema = z.object({
  type: DisputeTypeSchema,
  severity: SeveritySchema,
  action: DisputeActionSchema,
  reputation_impact: ReputationImpactSchema,
  blocklist_changes: BlocklistChangeSchema,
  escalated: z.boolean(),
  rationale: z.string().min(1).max(600),
  outreach: OutreachSchema,
});

// =========================================================
// Public types
// =========================================================

export type DisputeAgentInput = {
  disputeType: DisputeType;
  filedBy: 'user' | 'wali';
  narrative: string;
  counterPartyNarrative?: string;
  filerSpec: TwinSpec;
  counterpartySpec: TwinSpec;
};

export type DisputeAgentOutput = {
  resolution: DisputeResolution;
  fromFallback: boolean;
};

// Re-export for workplan convenience
export type { DisputeResolution, DisputeType, DisputeAction };

// =========================================================
// Entry point
// =========================================================

export async function runDisputeAgent(
  input: DisputeAgentInput,
  bus: TraceBus
): Promise<DisputeAgentOutput> {
  taskStart(bus, 'dispute_mediation');
  obs(
    bus,
    'dispute',
    `dispute filed by ${input.filedBy}: type=${input.disputeType}, filer=${input.filerSpec.identity.name}, counterparty=${input.counterpartySpec.identity.name}, has_counter_narrative=${input.counterPartyNarrative !== undefined}`
  );

  const promptArgs: DisputePromptArgs = {
    disputeType: input.disputeType,
    filedBy: input.filedBy,
    narrative: input.narrative,
    counterPartyNarrative: input.counterPartyNarrative,
    filerSpec: input.filerSpec,
    counterpartySpec: input.counterpartySpec,
  };

  let resolution: DisputeResolution;
  let fromFallback = false;

  try {
    const gem = await geminiCall(
      {
        prompt: buildDisputePrompt(promptArgs),
        modelTier: 'pro',
        temperature: 0.3,
        maxOutputTokens: 1400,
        responseFormat: 'json',
      },
      bus
    );
    const parsed = DisputeResolutionSchema.parse(JSON.parse(gem.text));
    // Cast through unknown to satisfy strict assignment — Zod narrows the
    // severity union but TypeScript doesn't see the literal widening as safe.
    resolution = parsed as unknown as DisputeResolution;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), type: input.disputeType },
      'dispute agent: Gemini call or schema parse failed; using deterministic fallback'
    );
    recover(
      bus,
      `dispute mediation Gemini call failed for type=${input.disputeType}`,
      'using deterministic fallback resolution — conservative severity applied'
    );
    resolution = fallbackResolution(promptArgs);
    fromFallback = true;
  }

  // Visible recovery moment: contradictory accounts detected.
  // Emit decide first (the ruling), then recover (the escalation signal).
  if (resolution.escalated && resolution.action === 'flag_for_human_review') {
    decide(
      bus,
      'dispute',
      `dispute escalated to human review — severity=${resolution.severity}, action=flag_for_human_review`,
      resolution.rationale
    );
    recover(
      bus,
      'contradictory accounts detected',
      'flagging for human review — both narratives logged in the dispute row'
    );
  } else {
    decide(
      bus,
      'dispute',
      `dispute ruling: severity=${resolution.severity}, action=${resolution.action}, escalated=${resolution.escalated}`,
      resolution.rationale
    );
  }

  obs(
    bus,
    'dispute',
    `reputation_impact entries=${resolution.reputation_impact.length}, blocklist_changes=${resolution.blocklist_changes.length}`
  );

  taskEnd(bus, 'dispute_mediation', {
    type: resolution.type,
    severity: resolution.severity,
    action: resolution.action,
    escalated: resolution.escalated,
    fromFallback,
  });

  return { resolution, fromFallback };
}

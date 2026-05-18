// Dispute Agent prompts — MASTERPLAN §5.8.
//
// Provides the Gemini Pro prompt that mediates post-meeting disputes between
// two parties. Covers five dispute types: no_show, misrepresentation, ghosting,
// family_rejection, and other.
//
// Two exports:
//   1. buildDisputePrompt — full Pro-tier JSON-mode prompt with severity rules.
//   2. fallbackResolution — deterministic fallback when the model call fails.
//      Recovers by escalating severity-4+ disputes and issuing a warning for
//      lower-severity cases. The trace records a recovery event at the agent.

import type { TwinSpec } from '../../domain/twin.js';

// =========================================================
// Public types
// =========================================================

export type DisputeType = 'no_show' | 'misrepresentation' | 'ghosting' | 'family_rejection' | 'other';

export type DisputeAction =
  | 'no_action'
  | 'warning'
  | 'shadowban'
  | 'flag_for_human_review'
  | 'mutual_close';

export type DisputeResolution = {
  type: DisputeType;
  severity: 1 | 2 | 3 | 4 | 5;
  action: DisputeAction;
  reputation_impact: { party: 'filer' | 'counterparty'; delta: number; reason: string }[];
  blocklist_changes: { party: 'filer' | 'counterparty'; blockedTwinId: string }[];
  escalated: boolean;
  rationale: string;
  outreach: { toRole: 'user' | 'wali_user' | 'counterparty'; messageKey: 'filed' | 'resolved' }[];
};

export type DisputePromptArgs = {
  disputeType: DisputeType;
  filedBy: 'user' | 'wali';
  narrative: string;
  counterPartyNarrative?: string;
  filerSpec: TwinSpec;
  counterpartySpec: TwinSpec;
};

// =========================================================
// Prompt builder
// =========================================================

export function buildDisputePrompt(args: DisputePromptArgs): string {
  const hasBothSides = args.counterPartyNarrative !== undefined && args.counterPartyNarrative.length >= 10;

  return `You are RishtaAI's Dispute Moderator Agent. Analyze the dispute below and produce a structured ruling.

DISPUTE TYPE: ${args.disputeType}
FILED BY: ${args.filedBy} (the filer)

FILER PROFILE:
  - Name: ${args.filerSpec.identity.name}, Age: ${args.filerSpec.identity.age}, City: ${args.filerSpec.identity.city}
  - Deen level: ${args.filerSpec.deen_level}
  - Conflict style: ${args.filerSpec.conflict_style}
  - Career: ${args.filerSpec.career.current}

COUNTERPARTY PROFILE:
  - Name: ${args.counterpartySpec.identity.name}, Age: ${args.counterpartySpec.identity.age}, City: ${args.counterpartySpec.identity.city}
  - Deen level: ${args.counterpartySpec.deen_level}
  - Conflict style: ${args.counterpartySpec.conflict_style}
  - Career: ${args.counterpartySpec.career.current}

FILER NARRATIVE:
${args.narrative}
${hasBothSides ? `\nCOUNTERPARTY NARRATIVE:\n${args.counterPartyNarrative ?? ''}` : '\nCOUNTERPARTY NARRATIVE: not yet submitted'}

SEVERITY RULES — apply exactly:
  1 = minor (e.g. running 15 min late) — action: "no_action".
  2 = moderate (e.g. abrupt unilateral cancellation without reason) — action: "warning", modest reputation_impact on filer or counterparty.
  3 = serious (e.g. confirmed no-show with no notice) — action: "warning" plus reputation_impact -0.1 to the no-show party.
  4 = severe (e.g. misrepresentation about deen level or marital status) — action: "shadowban" on counterparty plus reputation_impact -0.3.
  5 = critical (e.g. harassment, contradictory accounts that cannot be reconciled) — action: "flag_for_human_review", escalated: true.

RULES:
- If both narratives are present and directly contradict each other on material facts, treat as severity 5 with action "flag_for_human_review" and escalated: true.
- If only one narrative exists, give it reasonable benefit of the doubt; downgrade severity by 1 if the event could be a misunderstanding.
- "shadowban" means the counterparty is hidden from new matches but not notified.
- "mutual_close" is for cases where both parties agree to disengage with no blame.
- Repeat-offender pattern (same counterparty named in prior disputes in this filing's narrative) → action "shadowban" with a reason calling this out.
- reputation_impact deltas must be negative (penalty) or zero. Maximum delta magnitude: -0.3.
- blocklist_changes only if severity >= 4.
- outreach must include at least one entry for the filer (messageKey: "filed") and one for the counterparty (messageKey: "resolved" once settled).
- rationale: 1-2 sentences only. Plain English. No PII beyond first names already in the profiles.
- Do NOT invent facts. If insufficient evidence exists for a severe ruling, stay at severity 3 or below.
- Do NOT include emoji, hashtags, or marketing language.
- Output MUST be valid JSON only. No markdown. No trailing commas.

Output exactly this JSON shape:
{
  "type": "<one of: no_show | misrepresentation | ghosting | family_rejection | other>",
  "severity": <integer 1-5>,
  "action": "<one of: no_action | warning | shadowban | flag_for_human_review | mutual_close>",
  "reputation_impact": [
    { "party": "<filer | counterparty>", "delta": <negative number or 0>, "reason": "<short reason>" }
  ],
  "blocklist_changes": [
    { "party": "<filer | counterparty>", "blockedTwinId": "<twin id string>" }
  ],
  "escalated": <true | false>,
  "rationale": "<1-2 sentence plain English explanation of the ruling>",
  "outreach": [
    { "toRole": "<user | wali_user | counterparty>", "messageKey": "<filed | resolved>" }
  ]
}`;
}

// =========================================================
// Severity label helpers
// =========================================================

export type SeverityLabel = 'minor' | 'moderate' | 'serious' | 'severe' | 'critical';

export function severityLabel(severity: 1 | 2 | 3 | 4 | 5): SeverityLabel {
  const map: Record<1 | 2 | 3 | 4 | 5, SeverityLabel> = {
    1: 'minor',
    2: 'moderate',
    3: 'serious',
    4: 'severe',
    5: 'critical',
  };
  return map[severity];
}

export function actionLabel(action: DisputeAction): string {
  const map: Record<DisputeAction, string> = {
    no_action: 'no action required',
    warning: 'formal warning issued',
    shadowban: 'account restricted from new matches',
    flag_for_human_review: 'escalated to human moderator',
    mutual_close: 'mutual agreement to close',
  };
  return map[action];
}

// =========================================================
// Deterministic fallback
// =========================================================
// Used when the Gemini call fails entirely. Errs on the side of caution:
// severity-4+ gets escalated; everything else gets a warning.

export function fallbackResolution(args: DisputePromptArgs): DisputeResolution {
  // Misrepresentation is always treated as at least severe on fallback.
  const isHigh = args.disputeType === 'misrepresentation' || args.disputeType === 'no_show';
  const severity: 1 | 2 | 3 | 4 | 5 = isHigh ? 4 : 2;
  const action: DisputeAction = isHigh ? 'shadowban' : 'warning';
  const escalated = severity >= 4;

  const reputationImpact: DisputeResolution['reputation_impact'] = [
    {
      party: 'counterparty',
      delta: isHigh ? -0.3 : -0.05,
      reason: `Fallback ruling for ${args.disputeType} — Gemini call failed, conservative penalty applied`,
    },
  ];

  return {
    type: args.disputeType,
    severity,
    action,
    reputation_impact: reputationImpact,
    blocklist_changes: [],
    escalated,
    rationale: `Fallback ruling: Gemini mediation unavailable. Dispute type "${args.disputeType}" classified as ${severityLabel(severity)}. ${action === 'shadowban' ? 'Counterparty restricted pending human review.' : 'Warning issued to both parties.'}`,
    outreach: [
      { toRole: 'user', messageKey: 'filed' },
      { toRole: 'counterparty', messageKey: 'resolved' },
    ],
  };
}

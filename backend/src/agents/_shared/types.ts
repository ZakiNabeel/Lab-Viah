// Shared types for the Antigravity orchestration spine.
// Defined ONCE here; every agent/workplan/route imports from this file.
// See ANTIGRAVITY.md section 3 for the canonical contract.

export const DIMENSIONS = [
  'deen',
  'family',
  'career',
  'finances',
  'kids',
  'conflict',
  'geography',
  'dealbreakers',
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export const WORKPLANS = [
  'onboarding_flow',
  'find_matches',
  'book_meeting',
  'handle_dispute',
] as const;

export type WorkplanName = (typeof WORKPLANS)[number];

export type FlowId = string;

// =========================================================
// TraceEvent — the canonical event stream shape.
// =========================================================
export type TraceEvent =
  | { type: 'workplan.started'; workplan: WorkplanName; flowId: FlowId; ts: number }
  | { type: 'task.started'; task: string; ts: number }
  | { type: 'agent.observation'; agent: string; observation: string; ts: number }
  | {
      type: 'agent.decision';
      agent: string;
      decision: string;
      rationale: string;
      ts: number;
    }
  | { type: 'tool.call'; tool: string; args: unknown; ts: number }
  | { type: 'tool.result'; tool: string; result: unknown; latency_ms: number; ts: number }
  | { type: 'agent.message'; agent: string; content: string; ts: number }
  | {
      type: 'dimension.scored';
      dimension: Dimension;
      score: number;
      evidence: string;
      ts: number;
    }
  | { type: 'recovery'; reason: string; action: string; ts: number }
  | { type: 'task.finished'; task: string; outcome: unknown; ts: number }
  | { type: 'workplan.finished'; outcome: unknown; ts: number };

export type TraceEventType = TraceEvent['type'];

// =========================================================
// API envelope. Every route returns this shape.
// =========================================================
export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: { code: string; message: string; details?: unknown } };
export type ApiResponse<T> = ApiOk<T> | ApiErr;

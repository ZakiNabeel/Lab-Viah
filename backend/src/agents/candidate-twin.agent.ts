// Candidate Twin Agent — MASTERPLAN §5.4.
//
// Architecturally identical to User Twin (§5.3). Only difference: the Twin's
// spec is loaded from the seeded `candidates.ts` content (via the Moderator
// or workplan caller), not from the user's own onboarding output. The shared
// runTwinTurn engine in user-twin.agent.ts handles the actual Gemini call;
// this module exists per MASTERPLAN §4 to keep the per-side trace stamp
// clear (`agent: candidate_twin`) and to give the Moderator a self-
// documenting call site.

import type { TraceBus } from './_shared/trace.js';
import { runTwinTurn, type RunTwinTurnArgs } from './user-twin.agent.js';
import type { TwinTurnResult } from '../content/prompts/moderator.prompt.js';

export async function candidateTwinTurn(
  args: RunTwinTurnArgs,
  bus: TraceBus
): Promise<TwinTurnResult> {
  return runTwinTurn('candidate_twin', args, bus);
}

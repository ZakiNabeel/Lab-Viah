import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { supabase } from '../../db/client.js';
import type { FlowId, TraceEvent, WorkplanName } from './types.js';

// =========================================================
// TraceBus — the single chokepoint for all trace events.
// Every agent/workplan/tool routes through this. See ANTIGRAVITY.md §3.
// =========================================================

type Listener = (event: TraceEvent) => void;

export interface TraceBus {
  readonly flowId: FlowId;
  readonly workplan: WorkplanName;
  emit(event: TraceEvent): void;
  subscribe(listener: Listener): () => void;
  events(): readonly TraceEvent[];
  close(outcome: unknown): Promise<void>;
}

class InMemoryTraceBus implements TraceBus {
  public readonly flowId: FlowId;
  public readonly workplan: WorkplanName;
  private readonly emitter = new EventEmitter();
  private readonly buffer: TraceEvent[] = [];
  private closed = false;
  private readonly userId: string | null;

  constructor(workplan: WorkplanName, flowId: FlowId, userId: string | null) {
    this.workplan = workplan;
    this.flowId = flowId;
    this.userId = userId;
    this.emitter.setMaxListeners(50);
  }

  emit(event: TraceEvent): void {
    if (this.closed) {
      logger.warn(
        { flowId: this.flowId, type: event.type },
        'trace event emitted after bus closed — dropped'
      );
      return;
    }
    this.buffer.push(event);
    logger.debug({ flowId: this.flowId, event }, 'trace.event');
    this.emitter.emit('event', event);
  }

  subscribe(listener: Listener): () => void {
    // Replay buffered events so a late SSE subscriber catches up.
    for (const ev of this.buffer) listener(ev);
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  events(): readonly TraceEvent[] {
    return this.buffer;
  }

  async close(outcome: unknown): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const observations = this.buffer.filter((e) => e.type === 'agent.observation');
    const decisions = this.buffer.filter((e) => e.type === 'agent.decision');
    const toolCalls = this.buffer.filter((e) => e.type === 'tool.call' || e.type === 'tool.result');
    const recoveries = this.buffer.filter((e) => e.type === 'recovery');
    try {
      const { error } = await supabase.from('traces').insert({
        workplan: this.workplan,
        flow_id: this.flowId,
        user_id: this.userId,
        started_at: new Date(this.buffer[0]?.ts ?? Date.now()).toISOString(),
        finished_at: new Date().toISOString(),
        observations,
        decisions,
        tool_calls: toolCalls,
        recoveries,
        events: this.buffer,
        outcome,
      });
      if (error) {
        logger.error({ flowId: this.flowId, err: error.message }, 'failed to persist trace');
      }
    } catch (err) {
      logger.error({ flowId: this.flowId, err }, 'trace persistence threw');
    }
    this.emitter.removeAllListeners();
  }
}

// =========================================================
// Registry — global map of active buses by flowId.
// Lets the /stream/:flowId SSE handler look up a bus to subscribe to.
// =========================================================

const ACTIVE_BUSES = new Map<FlowId, TraceBus>();

export function startTrace(
  workplan: WorkplanName,
  opts?: { flowId?: FlowId; userId?: string | null }
): TraceBus {
  const flowId = opts?.flowId ?? randomUUID();
  const bus = new InMemoryTraceBus(workplan, flowId, opts?.userId ?? null);
  ACTIVE_BUSES.set(flowId, bus);
  bus.emit({ type: 'workplan.started', workplan, flowId, ts: Date.now() });
  return bus;
}

export function getTrace(flowId: FlowId): TraceBus | undefined {
  return ACTIVE_BUSES.get(flowId);
}

export async function endTrace(bus: TraceBus, outcome: unknown): Promise<void> {
  bus.emit({ type: 'workplan.finished', outcome, ts: Date.now() });
  await bus.close(outcome);
  ACTIVE_BUSES.delete(bus.flowId);
}

// =========================================================
// Helpers used by agents — guarantees ts is set so callers can't forget.
// =========================================================

export function obs(bus: TraceBus, agent: string, observation: string): void {
  bus.emit({ type: 'agent.observation', agent, observation, ts: Date.now() });
}

export function decide(bus: TraceBus, agent: string, decision: string, rationale: string): void {
  bus.emit({ type: 'agent.decision', agent, decision, rationale, ts: Date.now() });
}

export function recover(bus: TraceBus, reason: string, action: string): void {
  bus.emit({ type: 'recovery', reason, action, ts: Date.now() });
}

export function taskStart(bus: TraceBus, task: string): void {
  bus.emit({ type: 'task.started', task, ts: Date.now() });
}

export function taskEnd(bus: TraceBus, task: string, outcome: unknown): void {
  bus.emit({ type: 'task.finished', task, outcome, ts: Date.now() });
}

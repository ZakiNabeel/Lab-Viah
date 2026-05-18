/**
 * export-traces.ts
 *
 * One-shot script that reads from the Supabase `traces` table and writes
 * 5 JSONL files + an INDEX.md to the `traces/` directory.
 *
 * Run via:  npm run export-traces
 * See ANTIGRAVITY.md §7 for the canonical trace-export contract.
 */

import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../src/db/client.js';
import { logger } from '../src/utils/logger.js';
import type { TraceEvent } from '../src/agents/_shared/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TraceRow {
  id: string;
  workplan: string;
  flow_id: string;
  started_at: string;
  finished_at: string | null;
  events: TraceEvent[];
  recoveries: TraceEvent[];
  outcome: Record<string, unknown>;
}

interface ExportResult {
  filename: string;
  traceId: string;
  workplan: string;
  eventCount: number;
  recoveryCount: number;
  startedAt: string;
  outcomeSummary: string;
  skipped: boolean;
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const TRACES_DIR = resolve(__dirname, '../traces');

// ---------------------------------------------------------------------------
// Outcome summary helper
// ---------------------------------------------------------------------------

function outcomeSummary(outcome: Record<string, unknown>): string {
  const keys = Object.keys(outcome);
  if (keys.length === 0) return '{}';
  const pairs = keys.slice(0, 3).map((k) => {
    const v = outcome[k];
    const display =
      typeof v === 'string'
        ? v.slice(0, 40)
        : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : Array.isArray(v)
        ? `[array:${v.length}]`
        : typeof v === 'object' && v !== null
        ? '{...}'
        : String(v);
    return `${k}=${display}`;
  });
  return pairs.join(', ') + (keys.length > 3 ? ', …' : '');
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

async function queryLatestByOutcomeKey(
  workplan: string,
  outcomeKey: string
): Promise<TraceRow | null> {
  const { data, error } = await supabase
    .from('traces')
    .select('id, workplan, flow_id, started_at, finished_at, events, recoveries, outcome')
    .eq('workplan', workplan)
    .order('started_at', { ascending: false })
    .limit(50);

  if (error) {
    logger.error({ err: error.message, workplan }, 'query failed');
    return null;
  }
  if (!data) return null;

  for (const row of data) {
    const outcome = row.outcome as Record<string, unknown> | null;
    if (outcome && outcomeKey in outcome) {
      return row as TraceRow;
    }
  }
  return null;
}

async function queryLatestFindMatchesClean(): Promise<TraceRow | null> {
  // find_matches with topThree key and budgetExceeded != true
  const { data, error } = await supabase
    .from('traces')
    .select('id, workplan, flow_id, started_at, finished_at, events, recoveries, outcome')
    .eq('workplan', 'find_matches')
    .order('started_at', { ascending: false })
    .limit(50);

  if (error) {
    logger.error({ err: error.message }, 'query failed for find_matches clean');
    return null;
  }
  if (!data) return null;

  for (const row of data) {
    const outcome = row.outcome as Record<string, unknown> | null;
    if (
      outcome &&
      'topThree' in outcome &&
      outcome['budgetExceeded'] !== true &&
      outcome['budgetExceeded'] !== 'true'
    ) {
      return row as TraceRow;
    }
  }
  return null;
}

async function queryMostRecoveries(workplan: string): Promise<TraceRow | null> {
  const { data, error } = await supabase
    .from('traces')
    .select('id, workplan, flow_id, started_at, finished_at, events, recoveries, outcome')
    .eq('workplan', workplan)
    .order('started_at', { ascending: false })
    .limit(100);

  if (error) {
    logger.error({ err: error.message, workplan }, 'query failed for most-recoveries');
    return null;
  }
  if (!data || data.length === 0) return null;

  // Sort client-side by recovery count desc
  const sorted = [...data].sort((a, b) => {
    const aLen = Array.isArray(a.recoveries) ? a.recoveries.length : 0;
    const bLen = Array.isArray(b.recoveries) ? b.recoveries.length : 0;
    return bLen - aLen;
  });

  return (sorted[0] as TraceRow) ?? null;
}

async function queryByFlowId(flowId: string): Promise<TraceRow | null> {
  const { data, error } = await supabase
    .from('traces')
    .select('id, workplan, flow_id, started_at, finished_at, events, recoveries, outcome')
    .eq('flow_id', flowId)
    .limit(1)
    .single();

  if (error) {
    logger.error({ err: error.message, flowId }, 'query by flow_id failed');
    return null;
  }
  return (data as TraceRow) ?? null;
}

// ---------------------------------------------------------------------------
// Write one JSONL file from a TraceRow
// ---------------------------------------------------------------------------

async function writeJsonl(filename: string, row: TraceRow): Promise<void> {
  const events: TraceEvent[] = Array.isArray(row.events) ? row.events : [];
  const lines = events.map((ev) => JSON.stringify(ev)).join('\n');
  const content = lines.length > 0 ? lines + '\n' : '\n';
  await writeFile(join(TRACES_DIR, filename), content, { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Export spec definitions
// ---------------------------------------------------------------------------

interface ExportSpec {
  filename: string;
  description: string;
  envOverride: string;
  query: () => Promise<TraceRow | null>;
}

const EXPORT_SPECS: ExportSpec[] = [
  {
    filename: 'onboarding_flow__01.jsonl',
    description: 'latest onboarding_flow with twinId in outcome',
    envOverride: 'EXPORT_ONBOARDING_FLOW_ID',
    query: () => queryLatestByOutcomeKey('onboarding_flow', 'twinId'),
  },
  {
    filename: 'find_matches__hero_scenario_C.jsonl',
    description: 'latest find_matches with topThree + budgetExceeded!=true (clean run)',
    envOverride: 'EXPORT_FIND_MATCHES_FLOW_ID',
    query: () => queryLatestFindMatchesClean(),
  },
  {
    filename: 'book_meeting__01.jsonl',
    description: 'latest book_meeting with meetingId in outcome',
    envOverride: 'EXPORT_BOOK_MEETING_FLOW_ID',
    query: () => queryLatestByOutcomeKey('book_meeting', 'meetingId'),
  },
  {
    filename: 'handle_dispute__01.jsonl',
    description: 'latest handle_dispute with disputeId in outcome',
    envOverride: 'EXPORT_HANDLE_DISPUTE_FLOW_ID',
    query: () => queryLatestByOutcomeKey('handle_dispute', 'disputeId'),
  },
  {
    filename: 'recovery__moderator_timeout.jsonl',
    description: 'find_matches row with most recoveries (recovery exemplar)',
    envOverride: 'EXPORT_RECOVERY_FLOW_ID',
    query: () => queryMostRecoveries('find_matches'),
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  logger.info({ tracesDir: TRACES_DIR }, 'starting trace export');

  const results: ExportResult[] = [];

  for (const spec of EXPORT_SPECS) {
    logger.info({ file: spec.filename }, 'processing');

    let row: TraceRow | null = null;

    // Check env override
    const overrideFlowId = process.env[spec.envOverride];
    if (overrideFlowId) {
      logger.info(
        { file: spec.filename, envVar: spec.envOverride, flowId: overrideFlowId },
        'using env override'
      );
      row = await queryByFlowId(overrideFlowId);
      if (!row) {
        logger.warn(
          { file: spec.filename, flowId: overrideFlowId },
          '[WARN] env override flow_id not found in DB — falling back to default query'
        );
      }
    }

    if (!row) {
      row = await spec.query();
    }

    if (!row) {
      logger.warn({ file: spec.filename }, `[WARN] no row found for ${spec.filename} — skipping`);
      results.push({
        filename: spec.filename,
        traceId: 'N/A',
        workplan: 'N/A',
        eventCount: 0,
        recoveryCount: 0,
        startedAt: 'N/A',
        outcomeSummary: 'no row found',
        skipped: true,
        skipReason: spec.description,
      });
      continue;
    }

    await writeJsonl(spec.filename, row);

    const eventCount = Array.isArray(row.events) ? row.events.length : 0;
    const recoveryCount = Array.isArray(row.recoveries) ? row.recoveries.length : 0;
    const summary = outcomeSummary(row.outcome ?? {});

    results.push({
      filename: spec.filename,
      traceId: row.id,
      workplan: row.workplan,
      eventCount,
      recoveryCount,
      startedAt: row.started_at,
      outcomeSummary: summary,
      skipped: false,
    });

    logger.info(
      { file: spec.filename, traceId: row.id, eventCount, recoveryCount },
      'written'
    );
  }

  // Write INDEX.md
  await writeIndexMd(results, generatedAt);

  // Final summary
  const exported = results.filter((r) => !r.skipped);
  const skipped = results.filter((r) => r.skipped);

  logger.info(`exported ${exported.length} trace files to ${TRACES_DIR}`);
  for (const r of exported) {
    logger.info(`  ${r.filename}  ->  ${r.eventCount} events, ${r.recoveryCount} recoveries`);
  }
  if (skipped.length > 0) {
    logger.warn(`  ${skipped.length} file(s) skipped (no matching DB row)`);
    for (const r of skipped) {
      logger.warn(`  [SKIPPED] ${r.filename}`);
    }
  }

  console.log(`\nexported ${exported.length} trace files to ${TRACES_DIR}`);
  for (const r of exported) {
    console.log(`  ${r.filename}  ->  ${r.eventCount} events, ${r.recoveryCount} recoveries`);
  }
  if (skipped.length > 0) {
    console.log(`\n  WARNING: ${skipped.length} file(s) skipped (no matching DB row):`);
    for (const r of skipped) {
      console.log(`    [SKIPPED] ${r.filename} — ${r.skipReason ?? ''}`);
    }
  }
}

// ---------------------------------------------------------------------------
// INDEX.md writer
// ---------------------------------------------------------------------------

async function writeIndexMd(results: ExportResult[], generatedAt: string): Promise<void> {
  const rows = results
    .map((r) => {
      const started =
        r.startedAt !== 'N/A' ? r.startedAt.slice(0, 16).replace('T', ' ') : 'N/A';
      const traceId = r.skipped ? '(skipped)' : r.traceId;
      const outcome = r.skipped ? r.skipReason ?? '' : r.outcomeSummary;
      return `| ${r.filename} | ${traceId} | ${r.workplan} | ${r.eventCount} | ${r.recoveryCount} | ${started} | ${outcome} |`;
    })
    .join('\n');

  const content = `# Trace Export Index

Generated: ${generatedAt}

| File | Trace ID | Workplan | Events | Recoveries | Started | Outcome |
|---|---|---|---|---|---|---|
${rows}

## Selection criteria

Each trace was selected by the following criteria, in order:

1. **onboarding_flow__01.jsonl** — Latest \`traces\` row where \`workplan='onboarding_flow'\` AND \`outcome\` contains a \`twinId\` key (successful twin creation, no error outcome). Ordered by \`started_at desc\`, limit 1.

2. **find_matches__hero_scenario_C.jsonl** — Latest \`traces\` row where \`workplan='find_matches'\` AND \`outcome\` contains a \`topThree\` key AND \`outcome.budgetExceeded != true\` (clean run, zero budget errors). Ordered by \`started_at desc\`, limit 1. Targets the Session 4 burst-smoke run.

3. **book_meeting__01.jsonl** — Latest \`traces\` row where \`workplan='book_meeting'\` AND \`outcome\` contains a \`meetingId\` key (successful booking). Ordered by \`started_at desc\`, limit 1.

4. **handle_dispute__01.jsonl** — Latest \`traces\` row where \`workplan='handle_dispute'\` AND \`outcome\` contains a \`disputeId\` key (dispute opened). Ordered by \`started_at desc\`, limit 1.

5. **recovery__moderator_timeout.jsonl** — The \`find_matches\` row with the most recoveries (recovery exemplar demonstrating the system's resilience). Selected by sorting all \`find_matches\` rows by \`recoveries\` array length descending. Targets the Session 3 Vertex burst meltdown row.

All criteria can be overridden per-file via environment variables:
\`EXPORT_ONBOARDING_FLOW_ID\`, \`EXPORT_FIND_MATCHES_FLOW_ID\`, \`EXPORT_BOOK_MEETING_FLOW_ID\`,
\`EXPORT_HANDLE_DISPUTE_FLOW_ID\`, \`EXPORT_RECOVERY_FLOW_ID\`.
Set any of these to a specific \`flow_id\` to pin an exact trace.
`;

  await writeFile(join(TRACES_DIR, 'INDEX.md'), content, { encoding: 'utf8' });
  logger.info({ file: 'INDEX.md' }, 'written');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'export-traces fatal error');
  process.exit(1);
});

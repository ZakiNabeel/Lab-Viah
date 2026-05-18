import { supabase } from '../src/db/client.js';

async function main() {
  const { data, error } = await supabase
    .from('traces')
    .select(
      'id, workplan, flow_id, started_at, finished_at, outcome, observations, decisions, tool_calls, recoveries, events'
    )
    .order('started_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('ERR', error.message);
    process.exit(1);
  }

  const rows = (data ?? []).map((r) => ({
    id: typeof r.id === 'string' ? r.id.slice(0, 8) : r.id,
    workplan: r.workplan,
    flow_id: typeof r.flow_id === 'string' ? r.flow_id.slice(0, 16) : null,
    started_at: typeof r.started_at === 'string' ? r.started_at.slice(0, 19) : null,
    ev_count: Array.isArray(r.events) ? r.events.length : 0,
    rec_count: Array.isArray(r.recoveries) ? r.recoveries.length : 0,
    dec_count: Array.isArray(r.decisions) ? r.decisions.length : 0,
    outcome_keys:
      r.outcome && typeof r.outcome === 'object' ? Object.keys(r.outcome as object).slice(0, 6) : [],
  }));

  console.log(`Total rows fetched: ${rows.length}`);
  console.log(JSON.stringify(rows, null, 2));

  const byWorkplan: Record<string, number> = {};
  for (const r of rows) byWorkplan[r.workplan ?? 'null'] = (byWorkplan[r.workplan ?? 'null'] ?? 0) + 1;
  console.log('\nBy workplan:', byWorkplan);

  const withRecoveries = rows.filter((r) => r.rec_count > 0);
  console.log(`\nRows with recoveries: ${withRecoveries.length}`);
  for (const r of withRecoveries.slice(0, 10)) {
    console.log(`  - ${r.workplan} flow=${r.flow_id} recs=${r.rec_count} started=${r.started_at}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

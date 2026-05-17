// Seed the 12 candidate Twins into the `twins` table.
//
// Run once after applying schema.sql, OR re-run any time candidate content
// changes. Upsert by stable id so the script is idempotent.
//
//   npm run seed
//
// Reads the live CANDIDATES content + the existing Supabase service-role
// client. The script writes `is_candidate=true`, `user_id=NULL`, leaves the
// `embedding` column NULL (prescreen uses an in-memory feature vector — the
// pgvector slot stays available for Session 5 polish).
//
// After seeding, MASTERPLAN §8.2 says to REINDEX the ivfflat index so it
// builds against the populated table. The script prints the SQL line — run
// it in the Supabase SQL editor:
//   REINDEX INDEX twins_embedding_idx;
// (No-op while embeddings remain NULL but harmless and documents intent.)

import { CANDIDATES } from '../content/candidates.js';
import { supabase } from './client.js';
import { logger } from '../utils/logger.js';

async function main(): Promise<void> {
  const rows = CANDIDATES.map((c) => ({
    id: c.id,
    user_id: null,
    is_candidate: true,
    version: c.spec.version,
    spec: c.spec,
  }));

  logger.info({ count: rows.length }, 'seeding candidate twins');

  const { data, error } = await supabase
    .from('twins')
    .upsert(rows, { onConflict: 'id' })
    .select('id, spec');

  if (error) {
    logger.fatal({ err: error.message }, 'seed failed');
    process.exit(1);
  }

  const upserted = Array.isArray(data) ? data : [];
  logger.info(
    {
      count: upserted.length,
      names: upserted.map((r) => {
        const spec = r.spec as { identity?: { name?: string } };
        return spec.identity?.name ?? r.id;
      }),
    },
    'seed complete'
  );

  // Reindex hint — only needed once after the table has rows. Print, not run.
  logger.info(
    'Run this once in the Supabase SQL Editor to rebuild the ivfflat index: REINDEX INDEX twins_embedding_idx;'
  );
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'seed threw');
  process.exit(1);
});

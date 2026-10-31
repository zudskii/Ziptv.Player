import { sql } from 'kysely';

import type { Executor } from './playlist-sql.js';

/** Tables that are loaded in bulk and then read through joins. */
type BulkTable = 'live_channels' | 'movies' | 'series' | 'episodes' | 'playlist_entries';

/** Below this, the planner's defaults are fine and autovacuum catches up on its own. */
const ANALYZE_THRESHOLD = 1_000;

/**
 * Refreshes planner statistics right after a bulk load.
 *
 * A freshly loaded table has no statistics until autovacuum's next pass (a minute or more).
 * Without them PostgreSQL plans the entry ↔ catalog joins as if the tables were tiny and picks
 * nested loops with sequential scans: with 50 000 channels one page took over a minute instead
 * of ~100 ms. ANALYZE samples a fixed number of rows (~30 000), so its cost does not grow with
 * the table. Best effort: a failure here must never fail the load that already succeeded.
 */
export async function analyzeAfterBulkLoad(db: Executor, table: BulkTable, loadedRows: number): Promise<void> {
  if (loadedRows < ANALYZE_THRESHOLD) return;
  try {
    await sql`ANALYZE ${sql.table(table)}`.execute(db);
  } catch {
    // autovacuum is the backstop
  }
}

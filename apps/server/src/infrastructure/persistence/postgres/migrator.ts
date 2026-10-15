import { Migrator } from 'kysely/migration';

import type { Logger } from '../../../application/ports/logger.js';
import type { Db } from './database.js';
import { MIGRATIONS } from './migrations/index.js';

/**
 * Applies pending migrations. Kysely takes a Postgres advisory lock for the run, so several
 * instances starting together apply each migration exactly once (the others wait).
 * Returns the names of the migrations applied by this call.
 */
export async function migrateToLatest(db: Db, logger: Logger): Promise<string[]> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } });
  const { error, results } = await migrator.migrateToLatest();
  for (const result of results ?? []) {
    if (result.status === 'Error') logger.error({ migration: result.migrationName }, 'Migration failed');
  }
  if (error) throw error instanceof Error ? error : new Error(`Migration failed: ${String(error)}`);
  return (results ?? []).filter((result) => result.status === 'Success').map((result) => result.migrationName);
}

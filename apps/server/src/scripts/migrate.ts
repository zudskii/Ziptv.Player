/**
 * Applies pending schema migrations without starting the server.
 *   npm run migrate -w @ziptv/server
 * (The server also applies them at boot unless RUN_MIGRATIONS=false.)
 */
import { existsSync } from 'node:fs';

import { loadConfig } from '../config/env.js';
import { createLogger } from '../infrastructure/logger.js';
import { createDatabase } from '../infrastructure/persistence/postgres/database.js';
import { migrateToLatest } from '../infrastructure/persistence/postgres/migrator.js';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig({ ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'info', JOBS_ENABLED: 'false' });
  const logger = createLogger(config);
  const database = createDatabase({ url: config.database.url, poolMax: 2 }, logger);
  try {
    const applied = await migrateToLatest(database.db, logger);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

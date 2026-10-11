/**
 * Applies pending data migrations without starting the server.
 *   npm run migrate -w @ziptv/server
 * (The server also applies them at boot unless RUN_MIGRATIONS=false.)
 */
import { existsSync } from 'node:fs';

import { loadConfig } from '../config/env.js';
import { buildContainer } from '../container.js';
import { connectDatabase, disconnectDatabase } from '../infrastructure/database.js';
import { createLogger } from '../infrastructure/logger.js';
import { applyMigrations, syncIndexes } from '../infrastructure/persistence/mongo/init.js';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig({ ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'info', JOBS_ENABLED: 'false' });
  const logger = createLogger(config);
  await connectDatabase(config.mongo.uri, logger);
  const container = buildContainer(config, logger);
  await syncIndexes();
  const applied = await applyMigrations(container.secrets, logger);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  await container.dispose();
  await disconnectDatabase();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

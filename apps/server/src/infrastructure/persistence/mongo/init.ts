import mongoose from 'mongoose';

import type { Logger } from '../../../application/ports/logger.js';
import type { SourceSecrets } from '../../../application/sources/secrets.js';
import { MIGRATIONS, runMigrations } from './migrations/index.js';

/** Creates missing indexes of every registered model (idempotent). */
export async function syncIndexes(): Promise<void> {
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
}

export async function applyMigrations(secrets: SourceSecrets, logger: Logger): Promise<string[]> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database is not connected');
  return runMigrations(MIGRATIONS, { db, secrets, logger });
}

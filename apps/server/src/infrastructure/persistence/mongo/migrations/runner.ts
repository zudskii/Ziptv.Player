import { hostname } from 'node:os';

import type mongoose from 'mongoose';

import type { Logger } from '../../../../application/ports/logger.js';
import type { SourceSecrets } from '../../../../application/sources/secrets.js';
import { isDuplicateKeyError } from '../mongo-utils.js';

export interface MigrationContext {
  db: mongoose.mongo.Db;
  secrets: SourceSecrets;
  logger: Logger;
  now: Date;
}

export interface Migration {
  /** Sortable, never renamed: "001-sources-from-playlists". */
  id: string;
  description: string;
  up(context: MigrationContext): Promise<void>;
}

const COLLECTION = 'migrations';
const LOCK_ID = '__lock__';
const LOCK_MS = 30 * 60_000;
const WAIT_MS = 2_000;

interface MigrationDoc {
  _id: string;
  appliedAt?: Date;
  durationMs?: number;
  description?: string;
  owner?: string | null;
  until?: Date | null;
}

/**
 * Applies pending data migrations in order, once, across any number of instances:
 * a lock document serialises runners, applied ids are recorded in `migrations`.
 * Migrations must be idempotent (a crash mid-way re-runs the same migration).
 */
export async function runMigrations(migrations: Migration[], context: Omit<MigrationContext, 'now'>, options: { waitForLockMs?: number } = {}): Promise<string[]> {
  const collection = context.db.collection<MigrationDoc>(COLLECTION);
  const owner = `${hostname()}:${process.pid}`;
  const ordered = [...migrations].sort((a, b) => a.id.localeCompare(b.id));

  const applied = new Set((await collection.find({ _id: { $ne: LOCK_ID } }, { projection: { _id: 1 } }).toArray()).map((doc) => doc._id));
  if (ordered.every((migration) => applied.has(migration.id))) return [];

  await acquireLock(collection, owner, options.waitForLockMs ?? 10 * 60_000);
  const ran: string[] = [];
  try {
    // Re-read under the lock: another instance may have applied some meanwhile.
    const done = new Set((await collection.find({ _id: { $ne: LOCK_ID } }, { projection: { _id: 1 } }).toArray()).map((doc) => doc._id));
    for (const migration of ordered) {
      if (done.has(migration.id)) continue;
      const started = Date.now();
      context.logger.info({ migration: migration.id }, `Applying migration: ${migration.description}`);
      await migration.up({ ...context, now: new Date() });
      await collection.insertOne({ _id: migration.id, appliedAt: new Date(), durationMs: Date.now() - started, description: migration.description });
      ran.push(migration.id);
      context.logger.info({ migration: migration.id, ms: Date.now() - started }, 'Migration applied');
    }
  } finally {
    await collection.updateOne({ _id: LOCK_ID, owner }, { $set: { owner: null, until: null } });
  }
  return ran;
}

async function acquireLock(collection: mongoose.mongo.Collection<MigrationDoc>, owner: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const now = new Date();
    try {
      const locked = await collection.findOneAndUpdate(
        { _id: LOCK_ID, $or: [{ until: null }, { until: { $lt: now } }] },
        { $set: { owner, until: new Date(now.getTime() + LOCK_MS) } },
        { upsert: true, returnDocument: 'after' },
      );
      if (locked) return;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for another instance to finish database migrations');
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  }
}

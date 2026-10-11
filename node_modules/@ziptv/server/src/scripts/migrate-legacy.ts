/**
 * One-time migration from the 1.x data model (Mongo `users.secretId` + `playlists.originalName`
 * pointing at files in `m3ulist/`) to 3.x (users with hashed tokens, file sources).
 *
 * Usage (from apps/server, target DB taken from MONGO_URI / .env):
 *   npm run migrate:legacy -- --legacy-uri "mongodb+srv://.../m3uplaylist" --files ../../../Ziptv.Server/m3ulist [--dry-run]
 * or with LEGACY_MONGO_URI / LEGACY_FILES_DIR in the environment (docker compose `tools`).
 *
 * - Idempotent: already migrated playlists are skipped, so it can be re-run safely.
 * - The legacy database is only read, never modified.
 * - Old clients keep their identity: on first start the new client exchanges its old
 *   secretId once (POST /sessions { legacySecretId }) and sees its playlists again.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import mongoose from 'mongoose';

import { loadConfig } from '../config/env.js';
import { buildContainer } from '../container.js';
import { createLogger } from '../infrastructure/logger.js';
import { applyMigrations, syncIndexes } from '../infrastructure/persistence/mongo/init.js';
import { SourceModel } from '../infrastructure/persistence/mongo/repositories/source.repository.js';
import { UserModel } from '../infrastructure/persistence/mongo/repositories/user.repository.js';

interface LegacyUser {
  secretId?: string;
}
interface LegacyPlaylist {
  listname?: string;
  originalName?: string;
  ownerId?: string;
}

const { values } = parseArgs({
  options: {
    'legacy-uri': { type: 'string' },
    files: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const legacyUri = values['legacy-uri'] ?? process.env.LEGACY_MONGO_URI;
  const filesDir = values.files ?? process.env.LEGACY_FILES_DIR;
  const dryRun = values['dry-run'] ?? false;
  if (!legacyUri || !filesDir) {
    console.error('Usage: migrate:legacy -- --legacy-uri <mongodb uri of 1.x> --files <path to m3ulist/> [--dry-run]');
    console.error('   or: LEGACY_MONGO_URI=… LEGACY_FILES_DIR=… npm run migrate:legacy');
    process.exit(1);
  }

  const config = loadConfig({ ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn', JOBS_ENABLED: 'false' });
  const logger = createLogger(config);

  const legacy = await mongoose.createConnection(legacyUri).asPromise();
  await mongoose.connect(config.mongo.uri);
  if (legacy.name === mongoose.connection.name && legacy.host === mongoose.connection.host) {
    throw new Error('Legacy and target database are the same. Point MONGO_URI to a new database.');
  }

  const container = buildContainer(config, logger);
  await syncIndexes();
  await applyMigrations(container.secrets, logger);
  const report = { users: 0, usersExisting: 0, playlists: 0, skippedExisting: 0, missingFiles: [] as string[], failed: [] as string[] };

  // 1) Users: keep the old secretId as a one-time claim ticket.
  const userIds = new Map<string, string>();
  const ensureUser = async (secretId: string): Promise<string> => {
    const cached = userIds.get(secretId);
    if (cached) return cached;
    const existing = await UserModel.findOne({ legacySecretId: secretId }).lean();
    if (existing) {
      report.usersExisting++;
      userIds.set(secretId, existing._id.toHexString());
      return existing._id.toHexString();
    }
    report.users++;
    if (dryRun) {
      const fake = new mongoose.Types.ObjectId().toHexString();
      userIds.set(secretId, fake);
      return fake;
    }
    // Placeholder hash (contains ':' so it can never equal a real sha256 hex digest).
    const created = await UserModel.create({ tokenHash: `legacy:${randomBytes(16).toString('hex')}`, legacySecretId: secretId });
    userIds.set(secretId, created._id.toHexString());
    return created._id.toHexString();
  };

  for (const user of await legacy.collection<LegacyUser>('users').find({}).toArray()) {
    if (user.secretId) await ensureUser(user.secretId);
  }

  // 2) Playlists: parse each legacy file with the current parser and store it as a file source.
  for (const playlist of await legacy.collection<LegacyPlaylist>('playlists').find({}).toArray()) {
    if (!playlist.ownerId || !playlist.originalName) continue;
    const fileName = path.basename(playlist.originalName); // never trust stored paths
    const filePath = path.join(filesDir, fileName);
    if (!existsSync(filePath)) {
      report.missingFiles.push(fileName);
      continue;
    }

    const ownerId = await ensureUser(playlist.ownerId);
    if (await SourceModel.exists({ ownerId, 'origin.fileName': fileName })) {
      report.skippedExisting++;
      continue;
    }
    if (dryRun) {
      report.playlists++;
      continue;
    }
    try {
      await container.sources.addFile(ownerId, {
        fileName,
        bytes: readFileSync(filePath),
        name: playlist.listname?.trim().slice(0, 80) || undefined,
      });
      report.playlists++;
    } catch (error) {
      report.failed.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(JSON.stringify({ dryRun, ...report }, null, 2));
  await container.dispose();
  await legacy.close();
  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

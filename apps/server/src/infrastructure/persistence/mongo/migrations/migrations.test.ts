import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SourceSecrets } from '../../../../application/sources/secrets.js';
import { createLogger } from '../../../logger.js';
import { AesSecretCipher, parseEncryptionKey } from '../../../crypto/secret-cipher.js';
import { parsePlaylistText } from '../../../parsers/m3u/index.js';
import { TEST_MONGO_URI } from '../../../../test/harness.js';
import { syncIndexes } from '../init.js';
import { LiveChannelModel, MovieModel } from '../repositories/catalog.repository.js';
import { SourceModel } from '../repositories/source.repository.js';
import { MIGRATIONS, runMigrations } from './index.js';

describe.skipIf(!TEST_MONGO_URI)('data migrations', () => {
  const secrets = new SourceSecrets(new AesSecretCipher(parseEncryptionKey('m'.repeat(40))));
  const logger = createLogger({ log: { level: 'silent' }, env: 'test' });
  const ownerId = new mongoose.Types.ObjectId();
  const urlPlaylistId = new mongoose.Types.ObjectId();
  const filePlaylistId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await mongoose.connect(TEST_MONGO_URI!, { dbName: `ziptv_migrations_${Date.now()}` });
    await syncIndexes();
    const db = mongoose.connection.db!;
    const parsed = parsePlaylistText(
      [
        '#EXTM3U',
        '#EXTINF:-1 tvg-id="one" group-title="News" catchup="shift" catchup-days="2",News One',
        'http://p.example/u/p/1.ts',
        '#EXTINF:-1 group-title="Movies",The Matrix (1999)',
        'http://p.example/movie/u/p/77.mp4',
      ].join('\n'),
    );
    await db.collection('playlists').insertMany([
      {
        _id: urlPlaylistId,
        ownerId,
        name: 'Provider',
        source: { type: 'url', url: 'http://p.example/get.php?username=u&password=p' },
        revision: 3,
        stats: { channels: 2, groups: 2, unplayable: 0 },
        epgUrls: ['http://epg.example/x.xml'],
        warnings: [],
        warningCount: 0,
        format: 'm3u',
        encoding: 'utf-8',
        refreshedAt: new Date('2026-09-01'),
        createdAt: new Date('2026-08-01'),
        updatedAt: new Date('2026-09-01'),
      },
      {
        _id: filePlaylistId,
        ownerId,
        name: 'Local',
        source: { type: 'file', fileName: 'local.m3u' },
        revision: 1,
        stats: { channels: 2, groups: 2, unplayable: 0 },
        epgUrls: [],
        warnings: [],
        warningCount: 0,
        format: 'm3u',
        encoding: 'utf-8',
        refreshedAt: new Date('2026-09-01'),
        createdAt: new Date('2026-08-02'),
        updatedAt: new Date('2026-09-01'),
      },
    ]);
    for (const [playlistId, revision] of [
      [urlPlaylistId, 3],
      [filePlaylistId, 1],
    ] as const) {
      await db.collection('channels').insertMany(parsed.channels.map((channel) => ({ playlistId, revision, ...channel })));
      // A stale revision must not be migrated.
      await db.collection('channels').insertOne({ playlistId, revision: revision - 1, ...parsed.channels[0]!, key: 'ffffffffffff' });
    }
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase().catch(() => undefined);
    await mongoose.disconnect();
  });

  it('turns 2.x playlists into sources (same ids, same channel keys, VOD split out, secrets encrypted)', async () => {
    const applied = await runMigrations(MIGRATIONS, { db: mongoose.connection.db!, secrets, logger });
    expect(applied).toEqual(['001-sources-from-playlists']);

    const url = await SourceModel.findById(urlPlaylistId).lean();
    expect(url).toMatchObject({
      name: 'Provider',
      type: 'm3u_url',
      origin: { kind: 'url', host: 'p.example' },
      revision: 1,
      stats: { live: 1, movies: 1, catchup: 1 },
      sync: { status: 'queued', autoSync: true },
      xtreamCandidate: true,
    });
    expect(url!.credential).not.toContain('password');
    expect(secrets.openCredential(url!.credential ?? null)).toEqual({ type: 'm3u_url', url: 'http://p.example/get.php?username=u&password=p' });

    const file = await SourceModel.findById(filePlaylistId).lean();
    expect(file).toMatchObject({ type: 'm3u_file', origin: { kind: 'file', fileName: 'local.m3u' }, sync: { status: 'idle', autoSync: false }, credential: null });

    const live = await LiveChannelModel.find({ sourceId: urlPlaylistId }).lean();
    expect(live.map((channel) => [channel.name, channel.revision, channel.catchup?.days])).toEqual([['News One', 1, 2]]);
    expect(live[0]!.key).toBe(parsePlaylistText('#EXTM3U\n#EXTINF:-1 group-title="News",News One\nhttp://x/1.ts').channels[0]!.key);
    expect(live[0]!.locator).toMatch(/^v1\./);
    expect(secrets.openLocator(live[0]!.locator!)?.url).toBe('http://p.example/u/p/1.ts');
    expect(await MovieModel.countDocuments({ sourceId: urlPlaylistId })).toBe(1);
  });

  it('is applied once (idempotent across runs/instances)', async () => {
    expect(await runMigrations(MIGRATIONS, { db: mongoose.connection.db!, secrets, logger })).toEqual([]);
    expect(await SourceModel.countDocuments({})).toBe(2);
  });
});

import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initPersistence } from './container.js';
import { parsePlaylistText } from './modules/m3u/index.js';
import { MongoChannelRepository } from './modules/playlists/channel.repository.js';
import { MongoPlaylistRepository, type PlaylistSnapshot } from './modules/playlists/playlist.repository.js';
import { MongoUserRepository, UserModel } from './modules/session/user.repository.js';

/**
 * Repository adapters against a real MongoDB. Runs only when TEST_MONGO_URI is set
 * (CI starts a mongo service container); skipped locally otherwise.
 */
const uri = process.env.TEST_MONGO_URI;

describe.skipIf(!uri)('Mongo repositories (integration)', () => {
  const users = new MongoUserRepository();
  const playlists = new MongoPlaylistRepository();
  const channels = new MongoChannelRepository();
  const ownerId = new mongoose.Types.ObjectId().toHexString();

  const snapshot = (revision: number, count: number): PlaylistSnapshot => ({
    revision,
    stats: { channels: count, groups: 1, unplayable: 0 },
    epgUrls: ['http://epg.example/guide.xml'],
    warnings: [{ line: 3, code: 'invalid_url', message: 'x' }],
    warningCount: 1,
    format: 'm3u',
    encoding: 'utf-8',
    refreshedAt: new Date(),
  });

  const bigList = (count: number, prefix: string) => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < count; i++) {
      lines.push(`#EXTINF:-1 tvg-id="id${i}" group-title="G${i % 7}" user-agent="UA",${prefix} ${i}`, `http://h.example/${prefix}/${i}.m3u8`);
    }
    return parsePlaylistText(lines.join('\n')).channels;
  };

  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `ziptv_test_${Date.now()}` });
    await initPersistence();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase().catch(() => undefined);
    await mongoose.disconnect();
  });

  it('users: create, lookup by token hash, one-time legacy claim', async () => {
    const user = await users.create('hash-a');
    expect((await users.findByTokenHash('hash-a'))?.id).toBe(user.id);

    await UserModel.create({ tokenHash: 'legacy-placeholder', legacySecretId: 'id123' });
    const claimed = await users.claimLegacy('id123', 'hash-b');
    expect(claimed).not.toBeNull();
    expect(await users.findByTokenHash('hash-b')).not.toBeNull();
    expect(await users.claimLegacy('id123', 'hash-c')).toBeNull();
  });

  it('playlists + channels: batched insert, ordered projection, lookup, CAS refresh, delete', async () => {
    const id = playlists.newId();
    const first = bigList(4_500, 'Ch'); // > one insert batch
    await channels.insertRevision(id, 1, first);
    const created = await playlists.create({ id, ownerId, name: 'Big', source: { type: 'url', url: 'http://h.example/l.m3u' }, snapshot: snapshot(1, first.length) });
    expect(created).toMatchObject({ id, ownerId, revision: 1, source: { type: 'url' }, warnings: [{ line: 3 }] });

    const summaries = await channels.listSummaries(id, 1);
    expect(summaries).toHaveLength(4_500);
    expect(summaries[0]).toEqual({ key: first[0]!.key, name: 'Ch 0', groups: ['G0'], logo: null, tvgId: 'id0', kind: 'hls', unplayableReason: null });
    expect(summaries.at(-1)?.name).toBe('Ch 4499');
    expect(Object.keys(summaries[0]!)).not.toContain('url');

    const found = await channels.findByKey(id, 1, first[10]!.key);
    expect(found).toMatchObject({ name: 'Ch 10', url: 'http://h.example/Ch/10.m3u8', headers: { 'user-agent': 'UA' }, attributes: { 'tvg-id': 'id10' } });

    // Refresh: new revision, CAS swap, old revision garbage-collected.
    const second = bigList(3, 'New');
    await channels.insertRevision(id, 2, second);
    expect(await playlists.replaceSnapshot(id, 5, snapshot(2, 3))).toBeNull(); // stale expected revision
    expect((await playlists.replaceSnapshot(id, 1, snapshot(2, 3)))?.revision).toBe(2);
    await channels.deleteRevisionsExcept(id, 2);
    expect(await channels.listSummaries(id, 1)).toHaveLength(0);
    expect((await channels.listSummaries(id, 2)).map((c) => c.name)).toEqual(['New 0', 'New 1', 'New 2']);

    expect(await playlists.countByOwner(ownerId)).toBe(1);
    expect((await playlists.rename(id, ownerId, 'Renamed'))?.name).toBe('Renamed');
    expect(await playlists.findOwned(id, new mongoose.Types.ObjectId().toHexString())).toBeNull();

    expect(await playlists.deleteOwned(id, ownerId)).toBe(true);
    await channels.deleteAll(id);
    expect(await channels.listSummaries(id, 2)).toHaveLength(0);
  }, 60_000);

  it('enforces unique channel keys per revision', async () => {
    const id = playlists.newId();
    const [channel] = bigList(1, 'Dup');
    await channels.insertRevision(id, 1, [channel!]);
    await expect(channels.insertRevision(id, 1, [channel!])).rejects.toThrow();
  });
});

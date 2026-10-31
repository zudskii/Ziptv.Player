import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { NewEntry } from '../../../application/ports/playlist-repository.js';
import type { NewSource } from '../../../application/ports/source-repository.js';
import { toStoredRevision } from '../../../application/sources/catalog-storage.js';
import { SourceSecrets } from '../../../application/sources/secrets.js';
import type { LiveChannelEntry } from '../../../domain/catalog/model.js';
import { newEntityId } from '../../../domain/shared/ids.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../../test/harness.js';
import { AesSecretCipher, parseEncryptionKey } from '../../crypto/secret-cipher.js';
import { PgAccountDataTransfer } from './repositories/account-data-transfer.js';
import { PgCatalogRepository } from './repositories/catalog.repository.js';
import { PgPlaylistEntryRepository } from './repositories/playlist-entry.repository.js';
import { PgPlaylistRepository } from './repositories/playlist.repository.js';
import { PgSourceRepository } from './repositories/source.repository.js';
import { PgUserRepository } from './repositories/user.repository.js';

const MAX = 1000;

describe.skipIf(!TEST_DATABASE_URL)('PostgreSQL playlists', () => {
  let testDb: TestDatabase;
  let users: PgUserRepository;
  let sources: PgSourceRepository;
  let catalog: PgCatalogRepository;
  let playlists: PgPlaylistRepository;
  let entries: PgPlaylistEntryRepository;
  let ownerId: string;
  const secrets = new SourceSecrets(new AesSecretCipher(parseEncryptionKey('k'.repeat(40)), []));

  beforeAll(async () => {
    testDb = await createTestDatabase();
    const { db } = testDb.database;
    users = new PgUserRepository(db);
    sources = new PgSourceRepository(db);
    catalog = new PgCatalogRepository(db);
    playlists = new PgPlaylistRepository(db);
    entries = new PgPlaylistEntryRepository(db);
    ownerId = (await users.createGuest()).id;
  });
  afterAll(async () => testDb?.close());

  // --- fixtures -------------------------------------------------------------------------------

  const channel = (key: string, name: string, extra: Partial<LiveChannelEntry> = {}): LiveChannelEntry => ({
    key, position: 0, name, groups: [], logo: null, tvgId: null, tvgName: null, kind: 'hls', unplayableReason: null,
    locator: { url: `http://example.com/${key}.m3u8`, headers: {} }, catchup: null, adult: false, xtream: null, addedAt: null, epg: null, ...extra,
  });

  /** A synced source (revision 1) with the given channels. */
  async function seedSource(channels: LiveChannelEntry[], owner = ownerId) {
    const id = sources.newId();
    const source: NewSource = {
      id, ownerId: owner, name: `Source ${id.slice(-4)}`, type: 'm3u_url', origin: { kind: 'url', host: 'example.com' }, credential: null,
      sync: { status: 'idle', stage: null, autoSync: false, intervalHours: 6, lastAttemptAt: null, lastSuccessAt: null, nextSyncAt: null, error: null, consecutiveFailures: 0, rerunRequested: false },
    };
    await sources.create(source);
    await replaceRevision(id, 1, channels);
    return id;
  }
  /** What a re-sync does: write the new revision, point the source at it. */
  async function replaceRevision(sourceId: string, revision: number, channels: LiveChannelEntry[]) {
    await catalog.insertRevision(sourceId, revision, toStoredRevision({ live: channels.map((c, position) => ({ ...c, position })), movies: [], series: [], episodes: [] }, secrets));
    await sql`UPDATE sources SET revision = ${revision} WHERE id = ${sourceId}`.execute(testDb.database.db);
    await catalog.deleteOtherRevisions(sourceId, revision);
  }
  const newEntry = (sourceId: string, key: string, name: string, group: NewEntry['group'] = null): NewEntry => ({ sourceId, sourceKey: key, originNameKey: name.toLowerCase(), name, logo: null, tvgId: null, group });
  async function newPlaylist(name = 'Playlist') {
    return playlists.create({ id: newEntityId(), ownerId, name });
  }
  const names = async (playlistId: string, filter: Parameters<typeof entries.list>[1] = {}) => (await entries.list(playlistId, filter, { offset: 0, limit: 1000 })).items.map((e) => e.name);
  const add = async (playlistId: string, list: NewEntry[]) => {
    const result = await entries.addEntries(playlistId, list, { maxEntries: MAX });
    expect(result.status).toBe('ok');
    return result;
  };

  // --- playlists and groups -------------------------------------------------------------------

  describe('playlists and groups', () => {
    it('creates, lists with counts, renames and deletes — only for the owner', async () => {
      const a = await newPlaylist('A');
      const src = await seedSource([channel('a1', 'One'), channel('a2', 'Two')]);
      await add(a.id, [newEntry(src, 'a1', 'One', { name: 'News' }), newEntry(src, 'a2', 'Two', { name: 'Sport' })]);

      const listed = (await playlists.list(ownerId)).find((p) => p.id === a.id)!;
      expect(listed).toMatchObject({ name: 'A', entryCount: 2, groupCount: 2, exportEnabled: false });

      const other = await users.createGuest();
      expect(await playlists.findOwned(a.id, other.id)).toBeNull();
      expect(await playlists.rename(a.id, other.id, 'Hacked')).toBeNull();
      expect(await playlists.deleteOwned(a.id, other.id)).toBe(false);
      expect((await playlists.rename(a.id, ownerId, 'B'))?.name).toBe('B');
      expect(await playlists.deleteOwned(a.id, ownerId)).toBe(true);
    });

    it('keeps group names unique ignoring case, and reorders strictly', async () => {
      const p = await newPlaylist();
      const news = (await playlists.createGroup(p.id, newEntityId(), 'News'))!;
      const sport = (await playlists.createGroup(p.id, newEntityId(), 'Sport'))!;
      expect(await playlists.createGroup(p.id, newEntityId(), 'NEWS')).toBeNull();
      expect(await playlists.renameGroup(p.id, sport.id, 'news')).toBe('duplicate');
      expect(await playlists.renameGroup(p.id, sport.id, 'Football')).toBe('ok');
      expect(await playlists.renameGroup(p.id, newEntityId(), 'X')).toBe('not_found');

      expect(await playlists.reorderGroups(p.id, [sport.id])).toBe(false); // must list every group
      expect(await playlists.reorderGroups(p.id, [sport.id, sport.id])).toBe(false);
      expect(await playlists.reorderGroups(p.id, [sport.id, newEntityId()])).toBe(false);
      expect(await playlists.reorderGroups(p.id, [sport.id, news.id])).toBe(true);
      expect((await playlists.listGroups(p.id)).map((g) => g.name)).toEqual(['Football', 'News']);
    });

    it('moves the entries of a deleted group to the end of the ungrouped list, or deletes them', async () => {
      const p = await newPlaylist();
      const src = await seedSource([channel('d1', 'Loose'), channel('d2', 'G-one'), channel('d3', 'G-two'), channel('d4', 'G-three')]);
      await add(p.id, [newEntry(src, 'd1', 'Loose'), newEntry(src, 'd2', 'G-one', { name: 'G' }), newEntry(src, 'd3', 'G-two', { name: 'G' }), newEntry(src, 'd4', 'G-three', { name: 'H' })]);
      const [g, h] = await playlists.listGroups(p.id);

      expect(await playlists.deleteGroup(p.id, g!.id, false)).toBe(true);
      expect(await names(p.id)).toEqual(['Loose', 'G-one', 'G-two', 'G-three']); // ungrouped first, in order
      expect(await names(p.id, { group: 'ungrouped' })).toEqual(['Loose', 'G-one', 'G-two']);

      expect(await playlists.deleteGroup(p.id, h!.id, true)).toBe(true);
      expect(await names(p.id)).toEqual(['Loose', 'G-one', 'G-two']);
      expect(await playlists.deleteGroup(p.id, h!.id, true)).toBe(false);
    });
  });

  // --- adding ---------------------------------------------------------------------------------

  describe('adding entries', () => {
    it('keeps source order inside each group, creates groups by name and is idempotent', async () => {
      const p = await newPlaylist();
      const src = await seedSource([channel('b1', 'B1'), channel('b2', 'B2'), channel('b3', 'B3'), channel('b4', 'B4')]);
      const list = [newEntry(src, 'b1', 'B1', { name: 'News' }), newEntry(src, 'b2', 'B2', { name: 'Sport' }), newEntry(src, 'b3', 'B3', { name: 'news' }), newEntry(src, 'b4', 'B4')];

      expect(await add(p.id, list)).toMatchObject({ added: 4, skipped: 0 });
      expect((await playlists.listGroups(p.id)).map((g) => [g.name, g.entryCount])).toEqual([['News', 2], ['Sport', 1]]); // "news" reused the group
      expect(await names(p.id)).toEqual(['B4', 'B1', 'B3', 'B2']);

      expect(await add(p.id, list)).toMatchObject({ added: 0, skipped: 4 });
      expect(await names(p.id)).toEqual(['B4', 'B1', 'B3', 'B2']);
    });

    it('appends new channels after what a group already holds', async () => {
      const p = await newPlaylist();
      const src = await seedSource([channel('c1', 'C1'), channel('c2', 'C2'), channel('c3', 'C3')]);
      await add(p.id, [newEntry(src, 'c1', 'C1', { name: 'G' }), newEntry(src, 'c2', 'C2', { name: 'G' })]);
      await add(p.id, [newEntry(src, 'c3', 'C3', { name: 'G' }), newEntry(src, 'c1', 'C1', { name: 'G' })]);
      expect(await names(p.id)).toEqual(['C1', 'C2', 'C3']);
    });

    it('serialises concurrent edits: positions never collide', async () => {
      const p = await newPlaylist();
      const channels = Array.from({ length: 12 }, (_, i) => channel(`e${i.toString().padStart(2, '0')}`, `E${i}`));
      const src = await seedSource(channels);
      await Promise.all(channels.map((c) => add(p.id, [newEntry(src, c.key, c.name, { name: 'G' })])));
      const { items } = await entries.list(p.id, {}, { offset: 0, limit: 100 });
      expect(items).toHaveLength(12);
      expect(new Set(items.map((i) => i.position)).size).toBe(12);
    });

    it('refuses a foreign group and rolls back completely when the playlist would exceed its limit', async () => {
      const p = await newPlaylist();
      const q = await newPlaylist();
      const foreign = (await playlists.createGroup(q.id, newEntityId(), 'Theirs'))!;
      const src = await seedSource([channel('f1', 'F1'), channel('f2', 'F2'), channel('f3', 'F3')]);

      expect(await entries.addEntries(p.id, [newEntry(src, 'f1', 'F1', { id: foreign.id })], { maxEntries: MAX })).toEqual({ status: 'group_not_found' });
      expect(await entries.addEntries(p.id, [newEntry(src, 'f1', 'F1', { name: 'New group' }), newEntry(src, 'f2', 'F2'), newEntry(src, 'f3', 'F3')], { maxEntries: 2 })).toEqual({ status: 'full' });
      expect((await entries.stats(p.id)).total).toBe(0);
      expect(await playlists.listGroups(p.id)).toEqual([]); // not even the group survived
    });
  });

  // --- reading --------------------------------------------------------------------------------

  describe('listing', () => {
    it('shows ungrouped first, filters, searches literally and pages', async () => {
      const p = await newPlaylist();
      const src = await seedSource([channel('l1', 'Alpha'), channel('l2', '100% Hits'), channel('l3', 'Beta'), channel('l4', 'Gamma')]);
      await add(p.id, [newEntry(src, 'l1', 'Alpha', { name: 'Z' }), newEntry(src, 'l2', '100% Hits', { name: 'Y' }), newEntry(src, 'l3', 'Beta'), newEntry(src, 'l4', 'Gamma', { name: 'Z' })]);
      const [z, y] = [(await playlists.listGroups(p.id))[0]!, (await playlists.listGroups(p.id))[1]!];

      expect(await names(p.id)).toEqual(['Beta', 'Alpha', 'Gamma', '100% Hits']); // ungrouped, Z, Y (creation order)
      expect(await names(p.id, { group: { id: z.id } })).toEqual(['Alpha', 'Gamma']);
      expect(await names(p.id, { group: { id: y.id } })).toEqual(['100% Hits']);
      expect(await names(p.id, { search: 'ALP' })).toEqual(['Alpha']);
      expect(await names(p.id, { search: '100%' })).toEqual(['100% Hits']);
      expect(await names(p.id, { search: '%' })).toEqual(['100% Hits']); // a wildcard is not a wildcard
      expect(await names(p.id, { search: '_eta' })).toEqual([]);

      const page = await entries.list(p.id, {}, { offset: 1, limit: 2 });
      expect(page.total).toBe(4);
      expect(page.items.map((e) => e.name)).toEqual(['Alpha', 'Gamma']);
    });

    it('derives status from the source’s current catalog: ok, missing, unplayable', async () => {
      const p = await newPlaylist();
      const src = await seedSource([channel('s1', 'Fine'), channel('s2', 'Soon gone'), channel('s3', 'Weird', { unplayableReason: 'drm' })]);
      await add(p.id, ['s1', 's2', 's3'].map((k, i) => newEntry(src, k, ['Fine', 'Soon gone', 'Weird'][i]!)));
      const status = async () => Object.fromEntries((await entries.list(p.id, {}, { offset: 0, limit: 10 })).items.map((e) => [e.name, e.status]));
      expect(await status()).toEqual({ Fine: 'ok', 'Soon gone': 'ok', Weird: 'unplayable' });

      await replaceRevision(src, 2, [channel('s1', 'Fine'), channel('s3', 'Weird', { unplayableReason: 'drm' })]); // a sync dropped s2
      expect(await status()).toEqual({ Fine: 'ok', 'Soon gone': 'missing', Weird: 'unplayable' });
      expect(await names(p.id, { missingOnly: true })).toEqual(['Soon gone']);
      expect(await entries.stats(p.id)).toEqual({ total: 3, missing: 1, ungrouped: 3 });
    });
  });

  // --- editing --------------------------------------------------------------------------------

  describe('editing', () => {
    it('updates and clears fields, and only inside its own playlist', async () => {
      const p = await newPlaylist();
      const other = await newPlaylist();
      const src = await seedSource([channel('u1', 'Old name')]);
      await add(p.id, [newEntry(src, 'u1', 'Old name')]);
      const entry = (await entries.list(p.id, {}, { offset: 0, limit: 1 })).items[0]!;

      const updated = await entries.update(p.id, entry.id, { name: 'New name', logo: 'http://x/l.png', tvgId: 'tv.1', number: 7 });
      expect(updated).toMatchObject({ name: 'New name', logo: 'http://x/l.png', tvgId: 'tv.1', number: 7 });
      expect(await entries.update(p.id, entry.id, { logo: null, number: null })).toMatchObject({ name: 'New name', logo: null, number: null, tvgId: 'tv.1' });
      expect(await entries.update(other.id, entry.id, { name: 'Hijack' })).toBeNull();
      expect(await entries.update(p.id, entry.id, {})).toMatchObject({ name: 'New name' }); // empty patch is a read
    });

    it('moves entries between groups in display order, before a given entry or at the end', async () => {
      const p = await newPlaylist();
      const keys = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
      const src = await seedSource(keys.map((k) => channel(k, k.toUpperCase())));
      await add(p.id, [
        newEntry(src, 'm1', 'M1', { name: 'A' }), newEntry(src, 'm2', 'M2', { name: 'A' }), newEntry(src, 'm3', 'M3', { name: 'A' }),
        newEntry(src, 'm4', 'M4', { name: 'B' }), newEntry(src, 'm5', 'M5', { name: 'B' }), newEntry(src, 'm6', 'M6'),
      ]);
      const [a, b] = await playlists.listGroups(p.id);
      const id = async (name: string) => (await entries.list(p.id, {}, { offset: 0, limit: 100 })).items.find((e) => e.name === name)!.id;
      const inGroup = (group: string | null) => names(p.id, group ? { group: { id: group } } : { group: 'ungrouped' });

      // Appended to B; the request lists M3 before M1, but they keep the order the user sees.
      expect(await entries.move(p.id, [await id('M3'), await id('M1')], { groupId: b!.id, beforeEntryId: null })).toEqual({ moved: 2 });
      expect(await inGroup(a!.id)).toEqual(['M2']);
      expect(await inGroup(b!.id)).toEqual(['M4', 'M5', 'M1', 'M3']);

      // Inserted before M5.
      await entries.move(p.id, [await id('M2')], { groupId: b!.id, beforeEntryId: await id('M5') });
      expect(await inGroup(b!.id)).toEqual(['M4', 'M2', 'M5', 'M1', 'M3']);

      // Reordered inside its own group, and to ungrouped.
      await entries.move(p.id, [await id('M3')], { groupId: b!.id, beforeEntryId: await id('M4') });
      expect(await inGroup(b!.id)).toEqual(['M3', 'M4', 'M2', 'M5', 'M1']);
      await entries.move(p.id, [await id('M5')], { groupId: null, beforeEntryId: null });
      expect(await inGroup(null)).toEqual(['M6', 'M5']);

      // An unknown "before" means the end; foreign ids and foreign groups are ignored/refused.
      await entries.move(p.id, [await id('M6')], { groupId: b!.id, beforeEntryId: newEntityId() });
      expect((await inGroup(b!.id)).at(-1)).toBe('M6');
      expect(await entries.move(p.id, [newEntityId()], { groupId: null, beforeEntryId: null })).toEqual({ moved: 0 });
      expect(await entries.move(p.id, [await id('M1')], { groupId: newEntityId(), beforeEntryId: null })).toBe('group_not_found');
    });

    it('removes entries (only of this playlist) and renumbers in display order', async () => {
      const p = await newPlaylist();
      const other = await newPlaylist();
      const src = await seedSource([channel('r1', 'R1'), channel('r2', 'R2'), channel('r3', 'R3')]);
      await add(p.id, [newEntry(src, 'r1', 'R1', { name: 'G' }), newEntry(src, 'r2', 'R2'), newEntry(src, 'r3', 'R3', { name: 'G' })]);
      await add(other.id, [newEntry(src, 'r1', 'R1')]);
      const all = (await entries.list(p.id, {}, { offset: 0, limit: 10 })).items;

      expect(await entries.renumber(p.id, { start: 100, step: 10 })).toBe(3);
      expect((await entries.list(p.id, {}, { offset: 0, limit: 10 })).items.map((e) => [e.name, e.number])).toEqual([['R2', 100], ['R1', 110], ['R3', 120]]);
      expect((await entries.list(other.id, {}, { offset: 0, limit: 10 })).items[0]!.number).toBeNull(); // untouched

      const foreign = (await entries.list(other.id, {}, { offset: 0, limit: 10 })).items[0]!.id;
      expect(await entries.remove(p.id, [all[0]!.id, foreign])).toBe(1);
      expect(await entries.stats(other.id)).toMatchObject({ total: 1 });
      expect(await entries.remove(p.id, [])).toBe(0);
    });
  });

  // --- between playlists ----------------------------------------------------------------------

  describe('transfer', () => {
    async function twoPlaylists() {
      const from = await newPlaylist('From');
      const to = await newPlaylist('To');
      const src = await seedSource([channel('t1', 'T1'), channel('t2', 'T2'), channel('t3', 'T3')]);
      await add(from.id, [newEntry(src, 't1', 'T1', { name: 'News' }), newEntry(src, 't2', 'T2', { name: 'Sport' }), newEntry(src, 't3', 'T3')]);
      return { from, to, src };
    }
    const base = (from: string, to: string) => ({ fromPlaylistId: from, toPlaylistId: to, entryIds: 'all' as const, mode: 'copy' as const, placement: { by: 'name' as const }, maxEntries: MAX });

    it('copies everything keeping group names (creating them), numbers and edits; skips what is already there', async () => {
      const { from, to } = await twoPlaylists();
      const first = (await entries.list(from.id, {}, { offset: 0, limit: 10 })).items.find((e) => e.name === 'T1')!;
      await entries.update(from.id, first.id, { name: 'Renamed T1', number: 5 });

      expect(await entries.transfer(base(from.id, to.id))).toEqual({ status: 'ok', transferred: 3, skipped: 0 });
      expect((await playlists.listGroups(to.id)).map((g) => g.name)).toEqual(['News', 'Sport']);
      expect((await entries.list(to.id, {}, { offset: 0, limit: 10 })).items.map((e) => [e.name, e.number])).toEqual([['T3', null], ['Renamed T1', 5], ['T2', null]]);
      expect((await entries.stats(from.id)).total).toBe(3); // copy leaves the source alone

      expect(await entries.transfer(base(from.id, to.id))).toEqual({ status: 'ok', transferred: 0, skipped: 3 });
    });

    it('moves selected entries into one chosen group and removes them from the source', async () => {
      const { from, to } = await twoPlaylists();
      const target = (await playlists.createGroup(to.id, newEntityId(), 'Mixed'))!;
      const ids = (await entries.list(from.id, {}, { offset: 0, limit: 10 })).items.filter((e) => ['T1', 'T3'].includes(e.name)).map((e) => e.id);

      const result = await entries.transfer({ ...base(from.id, to.id), entryIds: ids, mode: 'move', placement: { by: 'group', groupId: target.id } });
      expect(result).toEqual({ status: 'ok', transferred: 2, skipped: 0 });
      expect(await names(from.id)).toEqual(['T2']);
      expect(await names(to.id, { group: { id: target.id } })).toEqual(['T3', 'T1']); // display order of the source
    });

    it('refuses a foreign target group and an overfull target, changing nothing', async () => {
      const { from, to } = await twoPlaylists();
      const foreign = (await playlists.createGroup(from.id, newEntityId(), 'Not in target'))!;
      expect(await entries.transfer({ ...base(from.id, to.id), placement: { by: 'group', groupId: foreign.id } })).toEqual({ status: 'group_not_found' });
      expect(await entries.transfer({ ...base(from.id, to.id), mode: 'move', maxEntries: 2 })).toEqual({ status: 'full' });
      expect((await entries.stats(to.id)).total).toBe(0);
      expect((await entries.stats(from.id)).total).toBe(3);
    });

    it('does not deadlock when two playlists are merged into each other at once', async () => {
      const { from, to } = await twoPlaylists();
      const results = await Promise.all([entries.transfer(base(from.id, to.id)), entries.transfer(base(to.id, from.id))]);
      expect(results.every((r) => r.status === 'ok')).toBe(true);
    });
  });

  // --- surviving a re-sync --------------------------------------------------------------------

  describe('relink after a provider re-groups channels', () => {
    it('re-attaches an entry whose key changed to the single channel with its name', async () => {
      const p = await newPlaylist();
      const src = await seedSource([channel('x1', 'Euronews'), channel('x2', 'Arte')]);
      await add(p.id, [newEntry(src, 'x1', 'Euronews'), newEntry(src, 'x2', 'Arte')]);
      // The provider moved Euronews to another group: same channel, new key (the key includes the group).
      await replaceRevision(src, 2, [channel('y1', 'Euronews', { groups: ['International'] }), channel('x2', 'Arte')]);
      expect((await entries.stats(p.id)).missing).toBe(1);

      expect(await entries.relink({ sourceId: src })).toBe(1);
      expect((await entries.stats(p.id)).missing).toBe(0);
      expect(await entries.relink({ playlistId: p.id })).toBe(0); // nothing left to do
    });

    it('does nothing when the match is ambiguous or the new key is already in the playlist', async () => {
      const p = await newPlaylist();
      const src = await seedSource([channel('z1', 'Twin'), channel('z2', 'Solo')]);
      await add(p.id, [newEntry(src, 'z1', 'Twin'), newEntry(src, 'z2', 'Solo')]);
      // "Twin" now exists twice (ambiguous); "Solo" came back under a key the playlist already holds via another entry.
      await replaceRevision(src, 2, [channel('n1', 'Twin', { groups: ['A'] }), channel('n2', 'Twin', { groups: ['B'] }), channel('n3', 'Solo', { groups: ['C'] })]);
      await add(p.id, [newEntry(src, 'n3', 'Solo')]);

      expect(await entries.relink({ playlistId: p.id })).toBe(0);
      expect((await entries.stats(p.id)).missing).toBe(2);
    });
  });

  // --- export ---------------------------------------------------------------------------------

  describe('export', () => {
    it('lists exportable entries in display order with their current stream, and pages', async () => {
      const p = await newPlaylist();
      const src = await seedSource([
        channel('p1', 'P1', { catchup: { mode: 'shift', days: 3, template: null } }), channel('p2', 'P2'), channel('p3', 'P3'),
        channel('p4', 'P4', { locator: null }),
      ]);
      await add(p.id, [newEntry(src, 'p1', 'P1', { name: 'G' }), newEntry(src, 'p2', 'P2'), newEntry(src, 'p3', 'P3', { name: 'G' }), newEntry(src, 'p4', 'P4')]);
      await replaceRevision(src, 2, [channel('p1', 'P1', { catchup: { mode: 'shift', days: 3, template: null } }), channel('p2', 'P2'), channel('p4', 'P4', { locator: null })]); // p3 vanished; p4 has no URL

      const collect = async (batchSize: number) => {
        const rows = [];
        let batches = 0;
        for await (const batch of entries.exportBatches(p.id, batchSize)) {
          rows.push(...batch);
          batches++;
        }
        return { rows, batches };
      };
      const { rows } = await collect(100);
      expect(rows.map((r) => [r.name, r.groupName])).toEqual([['P2', null], ['P1', 'G']]);
      expect(secrets.openLocator(rows[0]!.locator)?.url).toBe('http://example.com/p2.m3u8');
      expect(rows[1]!.catchup).toEqual({ mode: 'shift', days: 3, template: null });
      // One row per query still walks every group in order (the keyset continues where it stopped).
      const tiny = await collect(1);
      expect(tiny.rows.map((r) => r.name)).toEqual(['P2', 'P1']);
      expect(tiny.batches).toBe(2);
    });

    it('finds a playlist by its link token and stops finding it when the link is revoked or replaced', async () => {
      const p = await newPlaylist();
      expect(await playlists.setExportToken(p.id, ownerId, { hash: 'hash-1', sealed: 'sealed-1' })).toBe(true);
      expect((await playlists.findByExportTokenHash('hash-1'))?.id).toBe(p.id);
      expect(await playlists.getExportTokenSealed(p.id, ownerId)).toBe('sealed-1');
      expect((await playlists.findOwned(p.id, ownerId))?.exportEnabled).toBe(true);

      await playlists.setExportToken(p.id, ownerId, { hash: 'hash-2', sealed: 'sealed-2' });
      expect(await playlists.findByExportTokenHash('hash-1')).toBeNull();
      await playlists.setExportToken(p.id, ownerId, null);
      expect(await playlists.findByExportTokenHash('hash-2')).toBeNull();
      expect((await playlists.findOwned(p.id, ownerId))?.exportEnabled).toBe(false);
      expect(await playlists.setExportToken(p.id, (await users.createGuest()).id, { hash: 'h', sealed: 's' })).toBe(false);
    });
  });

  // --- planner statistics ---------------------------------------------------------------------

  describe('statistics after bulk loads', () => {
    it('analyzes the tables it just filled, so the first read is planned for the real size', async () => {
      const { db } = testDb.database;
      // Autovacuum would hide the problem; switch it off so only our own ANALYZE can have run.
      await sql`ALTER TABLE live_channels SET (autovacuum_enabled = false)`.execute(db);
      await sql`ALTER TABLE playlist_entries SET (autovacuum_enabled = false)`.execute(db);
      const reltuples = async (table: string) => Number((await sql<{ reltuples: number }>`SELECT reltuples FROM pg_class WHERE relname = ${table}`.execute(db)).rows[0]!.reltuples);

      const channels = Array.from({ length: 1500 }, (_, i) => channel(`st${i.toString().padStart(5, '0')}`, `Stat ${i}`));
      const src = await seedSource(channels);
      expect(await reltuples('live_channels')).toBeGreaterThanOrEqual(1500); // -1 would mean "never analyzed"

      const p = await newPlaylist();
      expect((await entries.addEntries(p.id, channels.map((c) => newEntry(src, c.key, c.name)), { maxEntries: 5_000 })).status).toBe('ok');
      expect(await reltuples('playlist_entries')).toBeGreaterThanOrEqual(1500);
    });
  });

  // --- lifecycle ------------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('removes entries with their source, everything with the playlist, and moves with a merged guest', async () => {
      const p = await newPlaylist();
      const keep = await seedSource([channel('k1', 'K1')]);
      const drop = await seedSource([channel('k2', 'K2')]);
      await add(p.id, [newEntry(keep, 'k1', 'K1', { name: 'G' }), newEntry(drop, 'k2', 'K2', { name: 'G' })]);
      await sources.deleteOwned(drop, ownerId);
      expect(await names(p.id)).toEqual(['K1']);

      const guest = await users.createGuest();
      const account = (await users.createAccount({ email: 'playlists@example.com', passwordHash: 'h' }))!;
      const mine = await playlists.create({ id: newEntityId(), ownerId: guest.id, name: 'Guest list' });
      expect(await new PgAccountDataTransfer(testDb.database.db).mergeGuestInto(guest.id, account.id)).toBe(true);
      expect((await playlists.findOwned(mine.id, account.id))?.name).toBe('Guest list');

      expect(await playlists.deleteOwned(p.id, ownerId)).toBe(true);
      const left = await sql<{ n: string }>`SELECT count(*) AS n FROM playlist_entries WHERE playlist_id = ${p.id}`.execute(testDb.database.db);
      expect(Number(left.rows[0]!.n)).toBe(0);
    });
  });
});

import type {
  AddEntriesResultDto,
  AuthSessionDto,
  ChannelListDto,
  PlaylistDto,
  PlaylistEntryDto,
  PlaylistEntryPageDto,
  SessionDto,
  SourceDto,
} from '@ziptv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApp, TEST_DATABASE_URL, type TestApp } from '../test/harness.js';

const SOURCE_FILE = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="euro.1" group-title="News" tvg-logo="http://logo.example/e.png",Euronews',
  'http://example.com/euronews.m3u8',
  '#EXTINF:-1 group-title="News",CNN',
  'http://example.com/cnn.m3u8',
  '#EXTINF:-1 group-title="Sport",Eurosport',
  '#EXTVLCOPT:http-user-agent=SportUA',
  'http://example.com/eurosport.m3u8',
  '#EXTINF:-1,Local TV',
  'http://example.com/local.m3u8',
  '',
].join('\n');

let clientIp = 0;
/** The app trusts X-Forwarded-For; one address per call keeps per-IP limits from coupling tests. */
const ip = () => `10.${(++clientIp >> 8) & 255}.${clientIp & 255}.9`;

describe.skipIf(!TEST_DATABASE_URL)('Playlists end-to-end', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ TRUST_PROXY: '1' });
  });
  afterAll(async () => t.close());

  // --- helpers --------------------------------------------------------------------------------

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const api = (token: string, app: TestApp = t) => ({
    get: (url: string) => request(app.app).get(`/api/v1${url}`).set(bearer(token)).set('X-Forwarded-For', ip()),
    post: (url: string, body: object = {}) => request(app.app).post(`/api/v1${url}`).set(bearer(token)).set('X-Forwarded-For', ip()).send(body),
    patch: (url: string, body: object) => request(app.app).patch(`/api/v1${url}`).set(bearer(token)).set('X-Forwarded-For', ip()).send(body),
    put: (url: string, body: object) => request(app.app).put(`/api/v1${url}`).set(bearer(token)).set('X-Forwarded-For', ip()).send(body),
    del: (url: string, body?: object) => {
      const req = request(app.app).delete(`/api/v1${url}`).set(bearer(token)).set('X-Forwarded-For', ip());
      return body ? req.send(body) : req;
    },
  });
  async function guest(app: TestApp = t): Promise<string> {
    return ((await request(app.app).post('/api/v1/sessions').set('X-Forwarded-For', ip()).send({}).expect(201)).body as SessionDto).token;
  }
  async function uploadSource(token: string, text = SOURCE_FILE, app: TestApp = t): Promise<SourceDto> {
    return (await request(app.app).post('/api/v1/sources/upload').set(bearer(token)).set('X-Forwarded-For', ip()).attach('file', Buffer.from(text), 'list.m3u').expect(201)).body as SourceDto;
  }
  const replaceFile = (token: string, sourceId: string, text: string) =>
    request(t.app).post(`/api/v1/sources/${sourceId}/file`).set(bearer(token)).set('X-Forwarded-For', ip()).attach('file', Buffer.from(text), 'list.m3u').expect(200);
  async function newPlaylist(token: string, name = 'My playlist', app: TestApp = t): Promise<PlaylistDto> {
    return (await api(token, app).post('/playlists', { name }).expect(201)).body as PlaylistDto;
  }
  const addAll = (token: string, playlistId: string, sourceId: string, placement: object = { type: 'sourceGroups' }) =>
    api(token).post(`/playlists/${playlistId}/entries/from-source`, { sourceId, select: { type: 'all' }, placement });
  async function entriesOf(token: string, playlistId: string, query = ''): Promise<PlaylistEntryDto[]> {
    return ((await api(token).get(`/playlists/${playlistId}/entries?limit=500${query}`).expect(200)).body as PlaylistEntryPageDto).items;
  }
  const entryNamed = async (token: string, playlistId: string, name: string) => (await entriesOf(token, playlistId)).find((e) => e.name === name)!;
  const detail = async (token: string, id: string) => (await api(token).get(`/playlists/${id}`).expect(200)).body as PlaylistDto;
  const exportPath = (url: string) => new URL(url).pathname;
  const fetchExport = (url: string) => request(t.app).get(exportPath(url)).set('X-Forwarded-For', ip());
  /** The M3U type is not text/* for supertest, so it needs an explicit text parser to expose the body. */
  const downloadExport = (url: string) =>
    fetchExport(url)
      .buffer(true)
      .parse((res, done) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => done(null, data));
      });

  // --- the main story -------------------------------------------------------------------------

  it('builds a playlist from a source, reorganises it, and exports it as an M3U link', async () => {
    const token = await guest();
    const source = await uploadSource(token);
    const playlist = await newPlaylist(token);
    expect(playlist).toMatchObject({ entryCount: 0, groups: [], export: { enabled: false, url: null } });

    // Add every channel; source groups become playlist groups, the group-less channel stays loose.
    const added = (await addAll(token, playlist.id, source.id).expect(200)).body as AddEntriesResultDto;
    expect(added).toEqual({ added: 4, skipped: 0 });
    let shown = await detail(token, playlist.id);
    expect(shown.groups.map((g) => [g.name, g.entryCount])).toEqual([['News', 2], ['Sport', 1]]);
    expect(shown).toMatchObject({ entryCount: 4, ungroupedCount: 1, missingCount: 0 });
    expect((await entriesOf(token, playlist.id)).map((e) => e.name)).toEqual(['Local TV', 'Euronews', 'CNN', 'Eurosport']);
    expect((await entriesOf(token, playlist.id)).every((e) => /^[0-9a-f]{12}$/.test(e.sourceKey))).toBe(true); // the image proxy needs the channel key

    // A new group written on the spot, entries moved into it (CNN lands before Eurosport), groups reordered.
    const favorites = (await api(token).post(`/playlists/${playlist.id}/groups`, { name: 'Favorites' }).expect(201)).body as { id: string };
    const eurosport = await entryNamed(token, playlist.id, 'Eurosport');
    const cnn = await entryNamed(token, playlist.id, 'CNN');
    await api(token).post(`/playlists/${playlist.id}/entries/move`, { entryIds: [eurosport.id], groupId: favorites.id }).expect(200);
    await api(token).post(`/playlists/${playlist.id}/entries/move`, { entryIds: [cnn.id], groupId: favorites.id, beforeEntryId: eurosport.id }).expect(200);
    shown = await detail(token, playlist.id);
    const byName = Object.fromEntries(shown.groups.map((g) => [g.name, g.id]));
    await api(token).put(`/playlists/${playlist.id}/groups/order`, { groupIds: [byName.Favorites, byName.News, byName.Sport] }).expect(204);

    // Rename a channel, number everything, then hand-set one number.
    const local = await entryNamed(token, playlist.id, 'Local TV');
    expect((await api(token).patch(`/playlists/${playlist.id}/entries/${local.id}`, { name: 'My Local' }).expect(200)).body).toMatchObject({ name: 'My Local' });
    expect((await api(token).post(`/playlists/${playlist.id}/renumber`, { start: 10, step: 5 }).expect(200)).body).toEqual({ renumbered: 4 });
    const euronews = await entryNamed(token, playlist.id, 'Euronews');
    await api(token).patch(`/playlists/${playlist.id}/entries/${euronews.id}`, { number: 1 }).expect(200);

    // Turn the link on and download the playlist the way a player would: no session at all.
    const enabled = (await api(token).post(`/playlists/${playlist.id}/export`).expect(200)).body as { enabled: boolean; url: string };
    expect(enabled.url).toMatch(/\/p\/[A-Za-z0-9_-]{43}\.m3u$/);
    const file = await downloadExport(enabled.url).expect(200);
    expect(file.headers['content-type']).toMatch(/audio\/x-mpegurl/);
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.headers['access-control-allow-origin']).toBe('*');
    expect(file.body).toBe(
      [
        '#EXTM3U',
        '#EXTINF:-1 tvg-chno="10",My Local',
        'http://example.com/local.m3u8',
        '#EXTINF:-1 tvg-chno="15" group-title="Favorites",CNN',
        'http://example.com/cnn.m3u8',
        '#EXTINF:-1 tvg-chno="20" group-title="Favorites",Eurosport',
        '#EXTVLCOPT:http-user-agent=SportUA',
        'http://example.com/eurosport.m3u8',
        '#EXTINF:-1 tvg-id="euro.1" tvg-chno="1" tvg-logo="http://logo.example/e.png" group-title="News",Euronews',
        'http://example.com/euronews.m3u8',
        '',
      ].join('\n'),
    );

    // The owner can read the same link again later.
    // (Compared by path: supertest listens on a new port for every request.)
    const again = (await detail(token, playlist.id)).export;
    expect(again.enabled).toBe(true);
    expect(exportPath(again.url!)).toBe(exportPath(enabled.url));
  });

  // --- the link ---------------------------------------------------------------------------------

  it('replaces and revokes the link; anything else under /p answers the same 404', async () => {
    const token = await guest();
    const source = await uploadSource(token);
    const playlist = await newPlaylist(token);
    await addAll(token, playlist.id, source.id).expect(200);

    const first = ((await api(token).post(`/playlists/${playlist.id}/export`).expect(200)).body as { url: string }).url;
    await fetchExport(first).expect(200);

    const second = ((await api(token).post(`/playlists/${playlist.id}/export`).expect(200)).body as { url: string }).url;
    expect(second).not.toBe(first);
    await fetchExport(first).expect(404); // the old link died the moment a new one was made
    await fetchExport(second).expect(200);
    await request(t.app).get(`${exportPath(second).replace(/\.m3u$/, '.m3u8')}`).set('X-Forwarded-For', ip()).expect(200);

    await api(token).del(`/playlists/${playlist.id}/export`).expect(204);
    await fetchExport(second).expect(404);
    expect((await detail(token, playlist.id)).export).toEqual({ enabled: false, url: null });

    const dead = await fetchExport(second);
    for (const path of ['/p/short.m3u', `/p/${'A'.repeat(43)}.m3u`, `/p/${'A'.repeat(43)}`, `/p/${'A'.repeat(44)}.m3u`, '/p/']) {
      const res = await request(t.app).get(path).set('X-Forwarded-For', ip());
      expect(res.status, path).toBe(404);
      expect(res.body.error.code, path).toBe(dead.body.error.code);
    }
  });

  it('limits how fast the public link can be hammered', async () => {
    const tight = await startTestApp({ TRUST_PROXY: '1' });
    try {
      const probe = () => request(tight.app).get(`/p/${'B'.repeat(43)}.m3u`).set('X-Forwarded-For', '203.0.113.5');
      for (let i = 0; i < 60; i++) await probe().expect(404);
      await probe().expect(429);
    } finally {
      await tight.close();
    }
  });

  // --- surviving a re-sync ----------------------------------------------------------------------

  it('keeps every edit through a re-sync: vanished channels are flagged and left out, re-grouped ones are found again, new ones can be picked up', async () => {
    const token = await guest();
    const source = await uploadSource(token);
    const playlist = await newPlaylist(token);
    await addAll(token, playlist.id, source.id).expect(200);

    const euronews = await entryNamed(token, playlist.id, 'Euronews');
    await api(token).patch(`/playlists/${playlist.id}/entries/${euronews.id}`, { name: 'Euronews (mine)', number: 7 }).expect(200);
    const link = ((await api(token).post(`/playlists/${playlist.id}/export`).expect(200)).body as { url: string }).url;

    // The provider drops CNN, moves Euronews to another group (which changes its key) and adds Arte.
    await replaceFile(
      token,
      source.id,
      [
        '#EXTM3U',
        '#EXTINF:-1 group-title="International",Euronews', 'http://example.com/euronews-v2.m3u8',
        '#EXTINF:-1 group-title="Sport",Eurosport', 'http://example.com/eurosport.m3u8',
        '#EXTINF:-1,Local TV', 'http://example.com/local.m3u8',
        '#EXTINF:-1,Arte', 'http://example.com/arte.m3u8',
        '',
      ].join('\n'),
    );

    const shown = await detail(token, playlist.id);
    expect(shown.missingCount).toBe(1);
    const entries = await entriesOf(token, playlist.id);
    expect(entries.find((e) => e.name === 'CNN')?.status).toBe('missing');
    // Euronews was re-attached by name; the user's name and number survived, and it still sits in "News".
    expect(entries.find((e) => e.name === 'Euronews (mine)')).toMatchObject({ status: 'ok', number: 7 });
    expect(shown.groups.find((g) => g.name === 'News')?.entryCount).toBe(2);

    const exported = (await downloadExport(link).expect(200)).body as string;
    expect(exported).not.toContain('CNN');
    expect(exported).toContain('http://example.com/euronews-v2.m3u8'); // the *current* URL, not the one from when it was added
    expect(exported).toContain('tvg-chno="7"');

    // "Add all" again picks up only the new channel; the flagged entry is removed in one call.
    expect((await addAll(token, playlist.id, source.id).expect(200)).body).toEqual({ added: 1, skipped: 3 });
    const missing = ((await api(token).get(`/playlists/${playlist.id}/entries?status=missing`).expect(200)).body as PlaylistEntryPageDto).items;
    expect(missing.map((e) => e.name)).toEqual(['CNN']);
    expect((await api(token).del(`/playlists/${playlist.id}/entries`, { entryIds: missing.map((e) => e.id) }).expect(200)).body).toEqual({ removed: 1 });
    expect((await detail(token, playlist.id)).missingCount).toBe(0);
  });

  it('removes a playlist’s channels together with their source', async () => {
    const token = await guest();
    const source = await uploadSource(token);
    const playlist = await newPlaylist(token);
    await addAll(token, playlist.id, source.id).expect(200);
    await api(token).del(`/sources/${source.id}`).expect(204);
    expect((await detail(token, playlist.id)).entryCount).toBe(0);
  });

  // --- selecting what to add --------------------------------------------------------------------

  it('adds by source group or by channel key, and into a chosen group or none', async () => {
    const token = await guest();
    const source = await uploadSource(token);
    const channels = ((await api(token).get(`/live/${source.id}/channels`).expect(200)).body as ChannelListDto).channels;
    const keyOf = (name: string) => channels.find((c) => c.name === name)!.key;
    const playlist = await newPlaylist(token);
    const mine = ((await api(token).post(`/playlists/${playlist.id}/groups`, { name: 'Mine' }).expect(201)).body as { id: string }).id;

    const post = (select: object, placement: object) => api(token).post(`/playlists/${playlist.id}/entries/from-source`, { sourceId: source.id, select, placement });
    expect((await post({ type: 'groups', groups: ['sport'] }, { type: 'group', groupId: mine }).expect(200)).body).toEqual({ added: 1, skipped: 0 }); // case-insensitive
    expect((await post({ type: 'keys', keys: [keyOf('Local TV'), 'unknown-key'] }, { type: 'ungrouped' }).expect(200)).body).toEqual({ added: 1, skipped: 0 });
    expect((await post({ type: 'groups', groups: ['Nonexistent'] }, { type: 'ungrouped' }).expect(200)).body).toEqual({ added: 0, skipped: 0 });

    const entries = await entriesOf(token, playlist.id);
    expect(entries.map((e) => [e.name, e.groupId === mine ? 'Mine' : e.groupId])).toEqual([['Local TV', null], ['Eurosport', 'Mine']]);
    expect((await api(token).get(`/playlists/${playlist.id}/entries?ungrouped=true`).expect(200)).body.total).toBe(1);
    expect((await api(token).get(`/playlists/${playlist.id}/entries?search=euro`).expect(200)).body.total).toBe(1);
  });

  // --- between playlists ------------------------------------------------------------------------

  it('copies, moves and merges channels between playlists', async () => {
    const token = await guest();
    const source = await uploadSource(token);
    const a = await newPlaylist(token, 'A');
    const b = await newPlaylist(token, 'B');
    const c = await newPlaylist(token, 'C');
    await addAll(token, a.id, source.id).expect(200);

    // Merge A into B: groups and channels come along.
    expect((await api(token).post(`/playlists/${b.id}/merge`, { sourcePlaylistIds: [a.id] }).expect(200)).body).toEqual({ transferred: 4, skipped: 0 });
    expect((await detail(token, b.id)).groups.map((g) => g.name)).toEqual(['News', 'Sport']);
    expect((await api(token).post(`/playlists/${b.id}/merge`, { sourcePlaylistIds: [a.id] }).expect(200)).body).toEqual({ transferred: 0, skipped: 4 });

    // Move two channels from A into one group of C.
    const group = ((await api(token).post(`/playlists/${c.id}/groups`, { name: 'Picked' }).expect(201)).body as { id: string }).id;
    const ids = [(await entryNamed(token, a.id, 'CNN')).id, (await entryNamed(token, a.id, 'Local TV')).id];
    expect((await api(token).post(`/playlists/${a.id}/entries/transfer`, { entryIds: ids, toPlaylistId: c.id, mode: 'move', group: { groupId: group } }).expect(200)).body).toEqual({ transferred: 2, skipped: 0 });
    expect((await entriesOf(token, a.id)).map((e) => e.name).sort()).toEqual(['Euronews', 'Eurosport']);
    expect((await entriesOf(token, c.id)).map((e) => e.groupId)).toEqual([group, group]);

    await api(token).post(`/playlists/${a.id}/entries/transfer`, { entryIds: 'all', toPlaylistId: a.id, mode: 'copy' }).expect(400); // onto itself
    await api(token).post(`/playlists/${a.id}/merge`, { sourcePlaylistIds: [a.id] }).expect(400);
  });

  // --- ownership --------------------------------------------------------------------------------

  it('never lets one user see or touch another user’s playlists, groups, entries or sources', async () => {
    const owner = await guest();
    const intruder = await guest();
    const source = await uploadSource(owner);
    const playlist = await newPlaylist(owner);
    await addAll(owner, playlist.id, source.id).expect(200);
    const group = (await detail(owner, playlist.id)).groups[0]!;
    const entry = (await entriesOf(owner, playlist.id))[0]!;
    const link = ((await api(owner).post(`/playlists/${playlist.id}/export`).expect(200)).body as { url: string }).url;

    const mine = await newPlaylist(intruder, 'Intruder');
    const theirSource = await uploadSource(intruder);
    const attempts: [string, number][] = [];
    const tryIt = async (label: string, request_: Promise<{ status: number }>) => attempts.push([label, (await request_).status]);
    const i = api(intruder);
    await tryIt('read playlist', i.get(`/playlists/${playlist.id}`));
    await tryIt('list entries', i.get(`/playlists/${playlist.id}/entries`));
    await tryIt('rename', i.patch(`/playlists/${playlist.id}`, { name: 'x' }));
    await tryIt('delete', i.del(`/playlists/${playlist.id}`));
    await tryIt('enable export', i.post(`/playlists/${playlist.id}/export`));
    await tryIt('create group', i.post(`/playlists/${playlist.id}/groups`, { name: 'x' }));
    await tryIt('rename group', i.patch(`/playlists/${playlist.id}/groups/${group.id}`, { name: 'x' }));
    await tryIt('edit entry', i.patch(`/playlists/${playlist.id}/entries/${entry.id}`, { name: 'x' }));
    await tryIt('remove entries', i.del(`/playlists/${playlist.id}/entries`, { entryIds: [entry.id] }));
    await tryIt('renumber', i.post(`/playlists/${playlist.id}/renumber`));
    await tryIt('add from own source into theirs', i.post(`/playlists/${playlist.id}/entries/from-source`, { sourceId: theirSource.id, select: { type: 'all' }, placement: { type: 'ungrouped' } }));
    await tryIt('add THEIR source to MY playlist', i.post(`/playlists/${mine.id}/entries/from-source`, { sourceId: source.id, select: { type: 'all' }, placement: { type: 'ungrouped' } }));
    await tryIt('copy theirs into mine', i.post(`/playlists/${playlist.id}/entries/transfer`, { entryIds: 'all', toPlaylistId: mine.id, mode: 'copy' }));
    await tryIt('merge theirs into mine', i.post(`/playlists/${mine.id}/merge`, { sourcePlaylistIds: [playlist.id] }));
    expect(attempts.filter(([, status]) => status !== 404)).toEqual([]);

    // A group of someone else's playlist is not a valid target either.
    await i.post(`/playlists/${mine.id}/entries/from-source`, { sourceId: theirSource.id, select: { type: 'all' }, placement: { type: 'group', groupId: group.id } }).expect(404);

    // Nothing changed for the owner, and the intruder's own list shows only theirs.
    expect((await detail(owner, playlist.id)).name).toBe('My playlist');
    expect((await api(intruder).get('/playlists').expect(200)).body.map((p: { name: string }) => p.name)).toEqual(['Intruder']);
    await fetchExport(link).expect(200);
  });

  // --- limits and input -------------------------------------------------------------------------

  it('enforces the playlist and channel limits', async () => {
    const small = await startTestApp({ TRUST_PROXY: '1', MAX_CUSTOM_PLAYLISTS_PER_USER: '2', MAX_ENTRIES_PER_CUSTOM_PLAYLIST: '100' });
    try {
      const token = await guest(small);
      const big = ['#EXTM3U', ...Array.from({ length: 120 }, (_, n) => `#EXTINF:-1,Channel ${n}\nhttp://example.com/${n}.m3u8`), ''].join('\n');
      const source = await uploadSource(token, big, small);
      const one = await newPlaylist(token, 'One', small);
      await newPlaylist(token, 'Two', small);
      expect((await api(token, small).post('/playlists', { name: 'Three' }).expect(409)).body.error.code).toBe('PLAYLIST_LIMIT_REACHED');

      const channels = ((await api(token, small).get(`/live/${source.id}/channels`).expect(200)).body as ChannelListDto).channels;
      const add = (keys: string[]) => api(token, small).post(`/playlists/${one.id}/entries/from-source`, { sourceId: source.id, select: { type: 'keys', keys }, placement: { type: 'ungrouped' } });
      expect((await add(channels.slice(0, 120).map((c) => c.key)).expect(409)).body.error.code).toBe('PLAYLIST_FULL');
      expect((await api(token, small).get(`/playlists/${one.id}`).expect(200)).body.entryCount).toBe(0); // all or nothing
      await add(channels.slice(0, 100).map((c) => c.key)).expect(200);
      expect((await add([channels[100]!.key]).expect(409)).body.error.code).toBe('PLAYLIST_FULL');
    } finally {
      await small.close();
    }
  });

  it('rejects malformed input with clear errors and no side effects', async () => {
    const token = await guest();
    const source = await uploadSource(token);
    const playlist = await newPlaylist(token);
    await addAll(token, playlist.id, source.id).expect(200);
    const entry = (await entriesOf(token, playlist.id))[0]!;
    const a = api(token);

    await a.post('/playlists', { name: '   ' }).expect(400);
    await a.post('/playlists', { name: 'x'.repeat(121) }).expect(400);
    await a.post('/playlists', { name: 'ok', admin: true }).expect(400);
    await a.get('/playlists/not-a-uuid').expect(400);
    await a.patch(`/playlists/${playlist.id}/entries/${entry.id}`, {}).expect(400);
    await a.patch(`/playlists/${playlist.id}/entries/${entry.id}`, { number: 0 }).expect(400);
    await a.patch(`/playlists/${playlist.id}/entries/${entry.id}`, { number: 100_000 }).expect(400);
    await a.patch(`/playlists/${playlist.id}/entries/${entry.id}`, { number: 1.5 }).expect(400);
    await a.patch(`/playlists/${playlist.id}/entries/${entry.id}`, { logo: 'javascript:alert(1)' }).expect(400);
    await a.patch(`/playlists/${playlist.id}/entries/${entry.id}`, { name: '' }).expect(400);
    await a.post(`/playlists/${playlist.id}/entries/move`, { entryIds: [], groupId: null }).expect(400);
    await a.post(`/playlists/${playlist.id}/entries/move`, { entryIds: ['nope'], groupId: null }).expect(400);
    await a.post(`/playlists/${playlist.id}/entries/from-source`, { sourceId: source.id, select: { type: 'nothing' }, placement: { type: 'ungrouped' } }).expect(400);
    await a.post(`/playlists/${playlist.id}/renumber`, { start: 0 }).expect(400);
    await a.put(`/playlists/${playlist.id}/groups/order`, { groupIds: [] }).expect(400); // there are groups: all of them must be listed
    await a.get(`/playlists/${playlist.id}/entries?limit=100000`).expect(400);

    // Numbering must fit: 4 channels from 99 999 by 1 would overflow.
    expect((await a.post(`/playlists/${playlist.id}/renumber`, { start: 99_999, step: 1 }).expect(400)).body.error.message).toMatch(/highest number/);
    // Duplicate group names, ignoring case.
    await a.post(`/playlists/${playlist.id}/groups`, { name: 'Fresh' }).expect(201);
    expect((await a.post(`/playlists/${playlist.id}/groups`, { name: 'FRESH' }).expect(409)).body.error.code).toBe('GROUP_EXISTS');
    // Moving into a group that does not exist.
    await a.post(`/playlists/${playlist.id}/entries/move`, { entryIds: [entry.id], groupId: '0192f7d0-0000-7000-8000-000000000000' }).expect(404);
    expect((await detail(token, playlist.id)).entryCount).toBe(4);
  });

  it('deletes a group but keeps its channels (or deletes them on request)', async () => {
    const token = await guest();
    const source = await uploadSource(token);
    const playlist = await newPlaylist(token);
    await addAll(token, playlist.id, source.id).expect(200);
    const { groups } = await detail(token, playlist.id);
    const news = groups.find((g) => g.name === 'News')!;
    const sport = groups.find((g) => g.name === 'Sport')!;

    await api(token).del(`/playlists/${playlist.id}/groups/${news.id}`).expect(204);
    let shown = await detail(token, playlist.id);
    expect(shown).toMatchObject({ entryCount: 4, ungroupedCount: 3, groupCount: 1 });
    expect((await entriesOf(token, playlist.id)).slice(0, 3).map((e) => e.name)).toEqual(['Local TV', 'Euronews', 'CNN']);

    await api(token).del(`/playlists/${playlist.id}/groups/${sport.id}?entries=delete`).expect(204);
    shown = await detail(token, playlist.id);
    expect(shown).toMatchObject({ entryCount: 3, groupCount: 0 });
    await api(token).del(`/playlists/${playlist.id}/groups/${sport.id}`).expect(404);
  });

  // --- accounts -----------------------------------------------------------------------------------

  it('brings a guest’s playlists along when it logs in to an account with mergeGuest', async () => {
    const accountToken = ((await request(t.app).post('/api/v1/auth/register').set('X-Forwarded-For', ip()).send({ email: 'lists@example.com', password: 'correct horse battery' }).expect(201)).body as AuthSessionDto).token;
    await newPlaylist(accountToken, 'Account list');

    const guestToken = await guest();
    const source = await uploadSource(guestToken);
    const playlist = await newPlaylist(guestToken, 'Guest list');
    await addAll(guestToken, playlist.id, source.id).expect(200);

    const merged = (await request(t.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip()).set(bearer(guestToken)).send({ email: 'lists@example.com', password: 'correct horse battery', mergeGuest: true }).expect(200)).body as AuthSessionDto;
    const lists = (await api(merged.token).get('/playlists').expect(200)).body as { name: string; entryCount: number }[];
    expect(lists.map((l) => [l.name, l.entryCount])).toEqual([['Account list', 0], ['Guest list', 4]]);
  });

  it('refuses to merge a guest when the playlists would not fit, changing nothing', async () => {
    const tight = await startTestApp({ TRUST_PROXY: '1', MAX_CUSTOM_PLAYLISTS_PER_USER: '1' });
    try {
      const accountToken = ((await request(tight.app).post('/api/v1/auth/register').set('X-Forwarded-For', ip()).send({ email: 'full@example.com', password: 'correct horse battery' }).expect(201)).body as AuthSessionDto).token;
      await newPlaylist(accountToken, 'Mine', tight);
      const guestToken = await guest(tight);
      await newPlaylist(guestToken, 'Theirs', tight);

      const res = await request(tight.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip()).set(bearer(guestToken)).send({ email: 'full@example.com', password: 'correct horse battery', mergeGuest: true }).expect(409);
      expect(res.body.error.code).toBe('PLAYLIST_LIMIT_REACHED');
      expect((await api(guestToken, tight).get('/playlists').expect(200)).body).toHaveLength(1);
    } finally {
      await tight.close();
    }
  });
});

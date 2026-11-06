import type {
  ChannelListDto,
  HomeDto,
  ListStateDto,
  MoviePageDto,
  NotificationListDto,
  PlaybackPlanDto,
  ProfileDto,
  ProfileLibraryDto,
  ProgressItemDto,
  SearchResultDto,
  SessionDto,
  SourceDto,
  SourceProfilesDto,
} from '@ziptv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Clock } from '../application/ports/clock.js';
import { startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';

/**
 * Per-profile library (Phase 14), end to end: the account owns its sources, each profile sees the
 * ones assigned to it — and nothing of a source outside its library shows up anywhere (channels,
 * search, Home, Continue Watching, My List, notifications). Kids profiles start empty and their
 * library needs the PIN to change.
 */

const TS = Buffer.alloc(188 * 3, 0xff);
[0, 188, 376].forEach((offset) => (TS[offset] = 0x47));

function playlist(base: string, prefix: string): string {
  return [
    '#EXTM3U',
    `#EXTINF:-1 group-title="News",${prefix} News`,
    `${base}/live/${prefix}-news.ts`,
    `#EXTINF:6000 group-title="Action",${prefix} Matrix (1999)`,
    `${base}/vod/${prefix}-matrix.mp4`,
  ].join('\n');
}

describe.skipIf(!TEST_DATABASE_URL)('Per-profile library', () => {
  let t: TestApp;
  let origin: FakeOrigin;
  let token = '';
  let main: ProfileDto;
  let bob: ProfileDto;
  let kids: ProfileDto;
  let alpha: SourceDto; // added by the main profile for itself
  let shared: SourceDto; // added by the main profile for everyone
  let alphaBroken = false;
  let offsetMs = 0;
  const clock: Clock = { now: () => new Date(Date.now() + offsetMs) };
  const auth = (profileId?: string) => ({ Authorization: `Bearer ${token}`, ...(profileId ? { 'X-Profile-Id': profileId } : {}) });
  const get = async <T,>(path: string, profileId?: string, status = 200) => (await request(t.app).get(`/api/v1${path}`).set(auth(profileId)).expect(status)).body as T;
  const ids = (sources: SourceDto[]) => sources.map((source) => source.id).sort();

  async function waitForSource(id: string, done: (s: SourceDto) => boolean): Promise<SourceDto> {
    return waitFor(async () => {
      const current = (await request(t.app).get(`/api/v1/sources/${id}`).set(auth())).body as SourceDto;
      return done(current) ? current : null;
    });
  }

  beforeAll(async () => {
    origin = await startOrigin((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/alpha.m3u') {
        if (alphaBroken) return void res.writeHead(500).end();
        return void res.writeHead(200, { 'content-type': 'audio/x-mpegurl' }).end(playlist(`http://${req.headers.host}`, 'Alpha'));
      }
      if (path === '/shared.m3u') return void res.writeHead(200, { 'content-type': 'audio/x-mpegurl' }).end(playlist(`http://${req.headers.host}`, 'Shared'));
      if (path?.endsWith('.ts')) return void res.writeHead(200, { 'content-type': 'video/mp2t' }).end(TS);
      if (path?.endsWith('.mp4')) return void res.writeHead(200, { 'content-type': 'video/mp4' }).end(Buffer.from('ftyp'));
      res.writeHead(404).end();
    });
    t = await startTestApp({ JOBS_ENABLED: 'true' }, { clock });
    t.container.jobs.start();
    token = ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token;
    main = (await get<ProfileDto[]>('/profiles'))[0]!;
    // Profiles that exist before the sources are added.
    bob = (await request(t.app).post('/api/v1/profiles').set(auth()).send({ name: 'Bob' }).expect(201)).body as ProfileDto;
    kids = (await request(t.app).post('/api/v1/profiles').set(auth()).send({ name: 'Kids', kind: 'kids' }).expect(201)).body as ProfileDto;

    const a = (await request(t.app).post('/api/v1/sources').set(auth()).send({ type: 'm3u_url', url: `${origin.url}/alpha.m3u`, name: 'Alpha list' }).expect(202)).body as SourceDto;
    const s = (await request(t.app).post('/api/v1/sources').set(auth()).send({ type: 'm3u_url', url: `${origin.url}/shared.m3u`, name: 'Shared list', audience: 'all' }).expect(202)).body as SourceDto;
    expect(a.profileIds).toEqual([main!.id]);
    expect(s.profileIds.sort()).toEqual([main!.id, bob.id].sort()); // "all" = grown-ups; kids are assigned explicitly
    alpha = await waitForSource(a.id, (x) => x.revision === 1 && x.sync.status === 'idle');
    shared = await waitForSource(s.id, (x) => x.revision === 1 && x.sync.status === 'idle');
  });
  afterAll(async () => {
    await t?.close();
    await origin?.close();
  });

  it('each profile lists its own library; Settings → Sources sees the whole account', async () => {
    expect(ids(await get<SourceDto[]>('/sources'))).toEqual(ids([alpha, shared]));
    expect(ids(await get<SourceDto[]>('/sources', bob.id))).toEqual([shared.id]);
    expect(await get<SourceDto[]>('/sources', kids.id)).toEqual([]);
    const account = await get<SourceDto[]>('/sources?scope=account', bob.id);
    expect(ids(account)).toEqual(ids([alpha, shared]));
    expect(account.find((source) => source.id === alpha.id)!.profileIds).toEqual([main!.id]);
    // A kids profile cannot widen its view by asking for the account.
    expect(await get<SourceDto[]>('/sources?scope=account', kids.id)).toEqual([]);
    await get(`/sources/${alpha.id}`, kids.id, 404);
    await get(`/sources/${alpha.id}/profiles`, kids.id, 403);
  });

  it("a source outside the profile's library exists nowhere for it", async () => {
    // Channels, guide, VOD: the same 404 as another account's source.
    await get(`/live/${alpha.id}/channels`, bob.id, 404);
    await get(`/vod/${alpha.id}/movies`, bob.id, 404);
    await get(`/epg/now?sourceId=${alpha.id}`, bob.id, 404);
    const key = (await get<ChannelListDto>(`/live/${alpha.id}/channels`)).channels[0]!.key;
    await request(t.app).post('/api/v1/playback').set(auth(bob.id)).send({ content: { type: 'channel', sourceId: alpha.id, key }, secureContext: false }).expect(404);
    await request(t.app).put(`/api/v1/me/list/channel/${alpha.id}/${key}`).set(auth(bob.id)).expect(404);

    const search = await get<SearchResultDto>('/search?q=matrix', bob.id);
    expect(search.movies.map((movie) => movie.sourceId)).toEqual([shared.id]);
    const home = await get<HomeDto>('/home', bob.id);
    expect(home.sources.map((source) => source.id)).toEqual([shared.id]);
    expect(home.movies.every((movie) => movie.sourceId === shared.id)).toBe(true);
    expect(home.movies.length).toBeGreaterThan(0);
  });

  it('notices about a source reach only the profiles that see it', async () => {
    alphaBroken = true;
    await request(t.app).post(`/api/v1/sources/${alpha.id}/sync`).set(auth()).expect(202);
    await waitForSource(alpha.id, (x) => x.sync.status === 'failed');
    alphaBroken = false;
    const mine = await get<NotificationListDto>('/notifications');
    expect(mine.items.some((item) => item.type === 'source_failed' && item.title.startsWith('Alpha list'))).toBe(true);
    const bobs = await get<NotificationListDto>('/notifications', bob.id);
    expect(bobs.items.some((item) => item.title.startsWith('Alpha list'))).toBe(false);
    expect(bobs.unread).toBe(bobs.items.filter((item) => !item.read).length);
    // "Mark all read" in Bob's profile leaves the main profile's notice unread.
    await request(t.app).post('/api/v1/notifications/read').set(auth(bob.id)).send({ ids: 'all' }).expect(204);
    expect((await get<NotificationListDto>('/notifications')).items.find((item) => item.title.startsWith('Alpha list'))!.read).toBe(false);
    await request(t.app).post(`/api/v1/sources/${alpha.id}/sync`).set(auth()).expect(202);
    alpha = await waitForSource(alpha.id, (x) => x.sync.status === 'idle');
  });

  it('taking a source out of a library hides what was watched and kept from it; putting it back restores it', async () => {
    const movies = await get<MoviePageDto>(`/vod/${alpha.id}/movies`);
    const movie = movies.items[0]!;
    const plan = (await request(t.app).post('/api/v1/playback').set(auth()).send({ content: { type: 'movie', sourceId: alpha.id, key: movie.key }, secureContext: false }).expect(200)).body as PlaybackPlanDto;
    const event = (type: string, position: number) => request(t.app).post('/api/v1/playback/events').set(auth()).send({ sessionId: plan.sessionId, type, position, duration: 6000 }).expect(204);
    await event('start', 0);
    offsetMs += 60_000;
    await event('heartbeat', 1200);
    offsetMs += 60_000;
    await event('stop', 1800);
    await request(t.app).put(`/api/v1/me/list/movie/${alpha.id}/${movie.key}`).set(auth()).expect(200);
    expect((await get<ProgressItemDto[]>('/me/progress')).map((item) => item.sourceId)).toEqual([alpha.id]);

    const library = (await request(t.app).put(`/api/v1/profiles/${main!.id}/library`).set(auth()).send({ sourceIds: [shared.id] }).expect(200)).body as ProfileLibraryDto;
    expect(library.sourceIds).toEqual([shared.id]);
    expect(ids(await get<SourceDto[]>('/sources'))).toEqual([shared.id]);
    await get(`/live/${alpha.id}/channels`, undefined, 404);
    expect(await get<ProgressItemDto[]>('/me/progress')).toEqual([]);
    expect((await get<HomeDto>('/home')).continueWatching).toEqual([]);
    expect((await get<{ items: unknown[] }>('/me/history')).items).toEqual([]);
    expect((await get<ListStateDto>('/me/list')).items.some((item) => item.sourceId === alpha.id)).toBe(false);
    expect((await get<SearchResultDto>('/search?q=matrix')).movies.map((m) => m.sourceId)).toEqual([shared.id]);

    // Back in the library: nothing was lost.
    await request(t.app).put(`/api/v1/profiles/${main!.id}/library`).set(auth()).send({ sourceIds: [alpha.id, shared.id] }).expect(200);
    expect((await get<ProgressItemDto[]>('/me/progress')).map((item) => item.sourceId)).toEqual([alpha.id]);
    expect((await get<ListStateDto>('/me/list')).items.some((item) => item.sourceId === alpha.id && item.available)).toBe(true);
  });

  it('a source can be shared from Settings → Sources; unknown ids are refused', async () => {
    const profiles = (await request(t.app).put(`/api/v1/sources/${alpha.id}/profiles`).set(auth()).send({ profileIds: [main!.id, bob.id] }).expect(200)).body as SourceProfilesDto;
    expect(profiles.profileIds.sort()).toEqual([main!.id, bob.id].sort());
    expect((await get<ChannelListDto>(`/live/${alpha.id}/channels`, bob.id)).channels.length).toBeGreaterThan(0);
    expect((await get<SourceProfilesDto>(`/sources/${alpha.id}/profiles`)).profileIds.sort()).toEqual([main!.id, bob.id].sort());
    await request(t.app).put(`/api/v1/sources/${alpha.id}/profiles`).set(auth()).send({ profileIds: ['01900000-0000-7000-8000-000000000000'] }).expect(400);
    await request(t.app).put(`/api/v1/profiles/${bob.id}/library`).set(auth()).send({ sourceIds: ['01900000-0000-7000-8000-000000000000'] }).expect(404);
    // A kids profile cannot change sharing (kids are read-only on /sources).
    await request(t.app).put(`/api/v1/sources/${alpha.id}/profiles`).set(auth(kids.id)).send({ profileIds: [kids.id] }).expect(403);
  });

  it("a new grown-up profile starts with the account's sources, a new kids profile with none", async () => {
    const carol = (await request(t.app).post('/api/v1/profiles').set(auth()).send({ name: 'Carol' }).expect(201)).body as ProfileDto;
    expect(ids(await get<SourceDto[]>('/sources', carol.id))).toEqual(ids([alpha, shared]));
    expect((await get<ProfileLibraryDto>(`/profiles/${kids.id}/library`)).sourceIds).toEqual([]);
    await request(t.app).delete(`/api/v1/profiles/${carol.id}`).set(auth()).expect(204);
  });

  it("with a PIN, a kids profile's library changes only with the PIN", async () => {
    await request(t.app).put('/api/v1/me/parental/pin').set(auth()).send({ pin: '4826' }).expect(200);
    const refused = await request(t.app).put(`/api/v1/profiles/${kids.id}/library`).set(auth()).send({ sourceIds: [shared.id] }).expect(403);
    expect(refused.body.error.code).toBe('PIN_REQUIRED');
    await request(t.app).put(`/api/v1/sources/${shared.id}/profiles`).set(auth()).send({ profileIds: [main!.id, bob.id, kids.id] }).expect(403);
    // Grown-up profiles' libraries need no PIN.
    await request(t.app).put(`/api/v1/profiles/${bob.id}/library`).set(auth()).send({ sourceIds: [shared.id] }).expect(200);

    await request(t.app).put(`/api/v1/profiles/${kids.id}/library`).set(auth()).send({ sourceIds: [shared.id], pin: '4826' }).expect(200);
    const channels = await get<ChannelListDto>(`/live/${shared.id}/channels`, kids.id);
    expect(channels.channels.map((channel) => channel.name)).toContain('Shared News');
    await get(`/live/${alpha.id}/channels`, kids.id, 404);
  });
});

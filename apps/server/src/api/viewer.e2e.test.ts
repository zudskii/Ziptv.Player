import type {
  AuthSessionDto,
  ChannelListDto,
  HistoryPageDto,
  HomeDto,
  ListStateDto,
  MovieDetailsDto,
  MoviePageDto,
  MovieDto,
  PlaybackPlanDto,
  ProfileDto,
  ProgressItemDto,
  SearchResultDto,
  SeriesDetailsDto,
  SessionDto,
  SettingsDto,
  SourceDto,
  StorageUsageDto,
  VodOverviewDto,
} from '@ziptv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Clock } from '../application/ports/clock.js';
import { startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';

/**
 * Viewer experience end-to-end (Phase 5): profiles, My List, playback → history / progress,
 * Continue Watching and resume, Home rails, VOD browsing, unified search, settings, data,
 * guest → account merge. A controllable clock makes watch time deterministic.
 */

const HOUR = 3600_000;
const TS = Buffer.alloc(188 * 3, 0xff);
[0, 188, 376].forEach((offset) => (TS[offset] = 0x47));

let version = 1;

function xmltvTime(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}00 +0000`;
}

function guide(): string {
  const base = Math.floor(Date.now() / HOUR) * HOUR - 24 * HOUR;
  const parts = ['<?xml version="1.0"?><tv>', '<channel id="news.tv"><display-name>Daily News</display-name></channel>', '<channel id="sport.tv"><display-name>Arena Sport</display-name></channel>'];
  for (let hour = 0; hour < 48; hour++) {
    const start = new Date(base + hour * HOUR);
    const stop = new Date(start.getTime() + HOUR);
    parts.push(`<programme start="${xmltvTime(start)}" stop="${xmltvTime(stop)}" channel="news.tv"><title>Evening Bulletin ${hour}</title></programme>`);
    parts.push(`<programme start="${xmltvTime(start)}" stop="${xmltvTime(stop)}" channel="sport.tv"><title>Derby Night ${hour}</title><category>Sports</category></programme>`);
  }
  parts.push('</tv>');
  return parts.join('\n');
}

function playlist(base: string): string {
  const lines = [
    `#EXTM3U url-tvg="${base}/guide.xml"`,
    '#EXTINF:-1 tvg-id="news.tv" group-title="News",Daily News',
    `${base}/live/news.ts`,
    '#EXTINF:-1 tvg-id="sport.tv" group-title="Sports",Arena Sport',
    `${base}/live/sport.ts`,
    '#EXTINF:-1 group-title="XXX Adults",Night Club TV',
    `${base}/live/adult.ts`,
    '#EXTINF:6000 group-title="Action" tvg-logo="http://img.example/matrix.jpg",The Matrix (1999)',
    `${base}/vod/matrix.mp4`,
    '#EXTINF:5400 group-title="Drama" rating="8.9",Heat (1995)',
    `${base}/vod/heat.mp4`,
    '#EXTINF:2700 group-title="Shows",Breaking Bad S01E01 Pilot',
    `${base}/vod/bb101.mp4`,
    '#EXTINF:2700 group-title="Shows",Breaking Bad S01E02 Cat in the Bag',
    `${base}/vod/bb102.mp4`,
  ];
  if (version > 1) lines.push('#EXTINF:-1 group-title="News",Morning Desk', `${base}/live/morning.ts`);
  return lines.join('\n');
}

describe.skipIf(!TEST_DATABASE_URL)('Viewer experience end-to-end', () => {
  let t: TestApp;
  let origin: FakeOrigin;
  let token = '';
  let source: SourceDto;
  let channels: ChannelListDto;
  let matrix: MovieDto;
  let offsetMs = 0;
  const clock: Clock = { now: () => new Date(Date.now() + offsetMs) };
  const advance = (secs: number) => (offsetMs += secs * 1000);
  const auth = (profileId?: string) => ({ Authorization: `Bearer ${token}`, ...(profileId ? { 'X-Profile-Id': profileId } : {}) });

  beforeAll(async () => {
    origin = await startOrigin((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/list.m3u') return void res.writeHead(200, { 'content-type': 'audio/x-mpegurl' }).end(playlist(`http://${req.headers.host}`));
      if (path === '/guide.xml') return void res.writeHead(200, { 'content-type': 'application/xml' }).end(guide());
      if (path?.endsWith('.ts')) return void res.writeHead(200, { 'content-type': 'video/mp2t' }).end(TS);
      if (path?.endsWith('.mp4')) return void res.writeHead(200, { 'content-type': 'video/mp4' }).end(Buffer.from('ftyp'));
      res.writeHead(404).end();
    });
    t = await startTestApp({ JOBS_ENABLED: 'true' }, { clock });
    t.container.jobs.start();
    token = ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token;
    const added = (await request(t.app).post('/api/v1/sources').set(auth()).send({ type: 'm3u_url', url: `${origin.url}/list.m3u` }).expect(202)).body as SourceDto;
    source = await waitForSource(added.id, (s) => s.revision === 1 && s.sync.status === 'idle');
    await waitFor(async () => {
      const current = (await request(t.app).get(`/api/v1/sources/${source.id}`).set(auth())).body as SourceDto;
      return current.stats.epgMapped === 2 && !current.epg.syncing ? current : null;
    });
    channels = (await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(auth()).expect(200)).body as ChannelListDto;
  });
  afterAll(async () => {
    await t?.close();
    await origin?.close();
  });

  function waitForSource(id: string, done: (s: SourceDto) => boolean): Promise<SourceDto> {
    return waitFor(async () => {
      const current = (await request(t.app).get(`/api/v1/sources/${id}`).set(auth())).body as SourceDto;
      return done(current) ? current : null;
    });
  }
  const channel = (name: string) => channels.channels.find((c) => c.name === name)!;
  const play = async (content: Record<string, unknown>, profileId?: string) =>
    (await request(t.app).post('/api/v1/playback').set(auth(profileId)).send({ content, secureContext: false }).expect(200)).body as PlaybackPlanDto;
  const event = (sessionId: string, type: string, extra: Record<string, number> = {}, profileId?: string) =>
    request(t.app).post('/api/v1/playback/events').set(auth(profileId)).send({ sessionId, type, ...extra }).expect(204);

  it('creates the default profile on first use; kids profiles hide adult content; limits and errors', async () => {
    const [main] = (await request(t.app).get('/api/v1/profiles').set(auth()).expect(200)).body as ProfileDto[];
    expect(main).toMatchObject({ name: 'Me', isDefault: true, kind: 'standard', pinProtected: false });

    const kids = (await request(t.app).post('/api/v1/profiles').set(auth()).send({ name: '  Kids ', kind: 'kids' }).expect(201)).body as ProfileDto;
    expect(kids).toMatchObject({ name: 'Kids', kind: 'kids', isDefault: false });
    expect(kids.color).not.toBe(main!.color);

    expect(channels.channels.map((c) => c.name)).toContain('Night Club TV');
    const kidsChannels = (await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(auth(kids.id)).expect(200)).body as ChannelListDto;
    expect(kidsChannels.channels.map((c) => c.name)).not.toContain('Night Club TV');

    const unknown = await request(t.app).get('/api/v1/home').set(auth('01900000-0000-7000-8000-000000000000')).expect(404);
    expect(unknown.body.error.details).toEqual({ reason: 'profile' });
    expect((await request(t.app).delete(`/api/v1/profiles/${main!.id}`).set(auth()).expect(409)).body.error.code).toBe('CONFLICT');

    for (const name of ['A', 'B', 'C']) await request(t.app).post('/api/v1/profiles').set(auth()).send({ name }).expect(201);
    expect((await request(t.app).post('/api/v1/profiles').set(auth()).send({ name: 'Too many' }).expect(409)).body.error.code).toBe('PROFILE_LIMIT_REACHED');
    const all = (await request(t.app).get('/api/v1/profiles').set(auth()).expect(200)).body as ProfileDto[];
    for (const profile of all.filter((p) => ['A', 'B', 'C'].includes(p.name))) await request(t.app).delete(`/api/v1/profiles/${profile.id}`).set(auth()).expect(204);
    await request(t.app).patch(`/api/v1/profiles/${kids.id}`).set(auth()).send({ name: 'Little ones', pinProtected: true }).expect(400);
  });

  it('keeps My List per profile, refreshes snapshots and marks vanished items unavailable', async () => {
    const news = channel('Daily News');
    await request(t.app).put(`/api/v1/me/list/channel/${source.id}/${news.key}`).set(auth()).expect(200);
    const movies = (await request(t.app).get(`/api/v1/vod/${source.id}/movies?sort=name`).set(auth()).expect(200)).body as MoviePageDto;
    expect(movies.items.map((m) => m.name)).toEqual(['Heat', 'The Matrix']);
    matrix = movies.items[1]!;
    await request(t.app).put(`/api/v1/me/list/movie/${source.id}/${matrix.key}`).set(auth()).expect(200);
    await request(t.app).put(`/api/v1/me/list/movie/${source.id}/${matrix.key}`).set(auth()).expect(200); // idempotent
    await request(t.app).put(`/api/v1/me/list/movie/${source.id}/aaaaaaaaaaaa`).set(auth()).expect(404);

    const list = (await request(t.app).get('/api/v1/me/list').set(auth()).expect(200)).body as ListStateDto;
    expect(list.items.map((i) => [i.type, i.title, i.subtitle, i.available])).toEqual([
      ['movie', 'The Matrix', '1999', true],
      ['channel', 'Daily News', 'News', true],
    ]);
    const kids = ((await request(t.app).get('/api/v1/profiles').set(auth())).body as ProfileDto[]).find((p) => p.kind === 'kids')!;
    expect(((await request(t.app).get('/api/v1/me/list').set(auth(kids.id)).expect(200)).body as ListStateDto).items).toEqual([]);
    const details = (await request(t.app).get(`/api/v1/vod/${source.id}/movies/${matrix.key}`).set(auth()).expect(200)).body as MovieDetailsDto;
    expect(details).toMatchObject({ name: 'The Matrix', year: 1999, inMyList: true, progress: null });
  });

  it('records history and progress from playback, resumes, completes and survives a re-sync', async () => {
    const plan = await play({ type: 'movie', sourceId: source.id, key: matrix.key });
    expect(plan.resumeFrom).toBeNull();
    await event(plan.sessionId, 'start', { position: 0, duration: 6000 });
    advance(30);
    await event(plan.sessionId, 'heartbeat', { position: 20, duration: 6000 }); // under the start threshold
    expect((await request(t.app).get('/api/v1/me/progress').set(auth())).body).toEqual([]);
    advance(30);
    await event(plan.sessionId, 'heartbeat', { position: 1200, duration: 6000 });
    advance(600); // a long gap credits at most one heartbeat's worth
    await event(plan.sessionId, 'stop', { position: 1800, duration: 6000 });

    const progress = (await request(t.app).get('/api/v1/me/progress').set(auth()).expect(200)).body as ProgressItemDto[];
    expect(progress).toMatchObject([{ contentType: 'movie', title: 'The Matrix', position: 1800, duration: 6000, completed: false, remainingSecs: 4200 }]);
    const history = (await request(t.app).get('/api/v1/me/history').set(auth()).expect(200)).body as HistoryPageDto;
    expect(history.items).toMatchObject([{ id: plan.sessionId, contentType: 'movie', title: 'The Matrix', watchedSecs: 120 }]);

    // Events of this session sent as another profile are ignored.
    const kids = ((await request(t.app).get('/api/v1/profiles').set(auth())).body as ProfileDto[]).find((p) => p.kind === 'kids')!;
    await event(plan.sessionId, 'heartbeat', { position: 5990, duration: 6000 }, kids.id);
    expect(((await request(t.app).get('/api/v1/me/progress').set(auth())).body as ProgressItemDto[])[0]!.position).toBe(1800);

    // Gate: progress survives a sync (stable keys).
    version = 2;
    await request(t.app).post(`/api/v1/sources/${source.id}/sync`).set(auth()).expect(202);
    source = await waitForSource(source.id, (s) => s.revision === 2 && s.sync.status === 'idle');
    const again = await play({ type: 'movie', sourceId: source.id, key: matrix.key });
    expect(again.resumeFrom).toBe(1795);

    advance(30);
    await event(again.sessionId, 'stop', { position: 5950, duration: 6000 });
    expect((await request(t.app).get('/api/v1/me/progress').set(auth())).body).toEqual([]);
    const completed = (await request(t.app).get(`/api/v1/vod/${source.id}/movies/${matrix.key}`).set(auth())).body as MovieDetailsDto;
    expect(completed.progress).toMatchObject({ completed: true });

    // A reconnect continues the same viewing; another title or a foreign id gets a new one.
    const reconnect = (await request(t.app).post('/api/v1/playback').set(auth()).send({ content: { type: 'movie', sourceId: source.id, key: matrix.key }, secureContext: false, continueSession: again.sessionId }).expect(200)).body as PlaybackPlanDto;
    expect(reconnect.sessionId).toBe(again.sessionId);
    const heat = ((await request(t.app).get(`/api/v1/vod/${source.id}/movies?sort=name`).set(auth())).body as MoviePageDto).items[0]!;
    const other = (await request(t.app).post('/api/v1/playback').set(auth()).send({ content: { type: 'movie', sourceId: source.id, key: heat.key }, secureContext: false, continueSession: again.sessionId }).expect(200)).body as PlaybackPlanDto;
    expect(other.sessionId).not.toBe(again.sessionId);

    // Resume can be switched off.
    await request(t.app).patch('/api/v1/me/settings').set(auth()).send({ playback: { resumePlayback: false } }).expect(200);
    await request(t.app).patch('/api/v1/me/settings').set(auth()).send({ playback: { resumePlayback: true } }).expect(200);
  });

  it('series: episodes carry progress and "Play" resumes the next episode', async () => {
    const page = (await request(t.app).get(`/api/v1/vod/${source.id}/series`).set(auth()).expect(200)).body as { items: { key: string; name: string }[] };
    const bb = page.items.find((s) => s.name === 'Breaking Bad')!;
    let details = (await request(t.app).get(`/api/v1/vod/${source.id}/series/${bb.key}`).set(auth()).expect(200)).body as SeriesDetailsDto;
    expect(details.resume).toBeNull();
    const [pilot, second] = details.seasons[0]!.episodes;
    const plan = await play({ type: 'episode', sourceId: source.id, seriesKey: bb.key, key: pilot!.key });
    advance(40);
    await event(plan.sessionId, 'stop', { position: 2650, duration: 2700 });
    details = (await request(t.app).get(`/api/v1/vod/${source.id}/series/${bb.key}`).set(auth()).expect(200)).body as SeriesDetailsDto;
    expect(details.seasons[0]!.episodes[0]!.progress).toMatchObject({ completed: true });
    expect(details.resume).toMatchObject({ episodeKey: second!.key, season: 1, episode: 2, position: 0 });
  });

  it('builds Home with every rail (partial data allowed) and per-profile state', async () => {
    const home = (await request(t.app).get('/api/v1/home').set(auth()).expect(200)).body as HomeDto;
    expect(home.sources.map((s) => s.id)).toEqual([source.id]);
    expect(home.favorites.map((i) => i.title)).toEqual(['The Matrix', 'Daily News']);
    expect(home.recentlyWatched.map((i) => i.title)).toEqual(expect.arrayContaining(['Pilot', 'The Matrix']));
    expect(home.liveNow[0]!.channel.name).toBe('Daily News'); // favourite first
    expect(home.liveNow[0]!.now?.title).toMatch(/^Evening Bulletin/);
    expect(home.sportsLive.map((i) => i.channel.name)).toEqual(['Arena Sport']);
    expect(home.movies.map((m) => m.name).sort()).toEqual(['Heat', 'The Matrix']);
    expect(home.series.map((s) => s.name)).toEqual(['Breaking Bad']);
    expect(home.recentlyAdded.map((i) => [i.type, i.title])).toEqual([['channel', 'Morning Desk']]);

    const kids = ((await request(t.app).get('/api/v1/profiles').set(auth())).body as ProfileDto[]).find((p) => p.kind === 'kids')!;
    const kidsHome = (await request(t.app).get('/api/v1/home').set(auth(kids.id)).expect(200)).body as HomeDto;
    expect(kidsHome.favorites).toEqual([]);
    expect(kidsHome.continueWatching).toEqual([]);
  });

  it('browses VOD by category and sort with an overview of rails', async () => {
    const overview = (await request(t.app).get(`/api/v1/vod/${source.id}/movies/overview`).set(auth()).expect(200)).body as VodOverviewDto<MovieDto>;
    expect(overview.categories).toEqual([
      { name: 'Action', count: 1 },
      { name: 'Drama', count: 1 },
    ]);
    expect(overview.rails.map((r) => r.id)).toEqual(['recent', 'top', 'category-0', 'category-1']);
    expect(overview.rails.find((r) => r.id === 'top')!.items[0]!.name).toBe('Heat');
    const drama = (await request(t.app).get(`/api/v1/vod/${source.id}/movies?category=Drama`).set(auth()).expect(200)).body as MoviePageDto;
    expect(drama).toMatchObject({ total: 1, nextCursor: null, items: [{ name: 'Heat', rating: 8.9 }] });
    const first = (await request(t.app).get(`/api/v1/vod/${source.id}/movies?sort=name&limit=1`).set(auth()).expect(200)).body as MoviePageDto;
    expect(first).toMatchObject({ total: 2, nextCursor: '1', items: [{ name: 'Heat' }] });
    const second = (await request(t.app).get(`/api/v1/vod/${source.id}/movies?sort=name&limit=1&cursor=1`).set(auth()).expect(200)).body as MoviePageDto;
    expect(second).toMatchObject({ nextCursor: null, items: [{ name: 'The Matrix' }] });
    await request(t.app).get(`/api/v1/vod/${source.id}/movies?cursor=-5`).set(auth()).expect(400);
  });

  it('searches channels, movies, series and programmes; kids never get adult results', async () => {
    const result = (await request(t.app).get('/api/v1/search?q=night').set(auth()).expect(200)).body as SearchResultDto;
    expect(result.channels.map((c) => c.channel.name)).toEqual(['Night Club TV']);
    expect(result.programmes.map((p) => p.programme.title).every((title) => title.startsWith('Derby Night'))).toBe(true);
    expect(result.programmes.length).toBeGreaterThan(0);
    const kids = ((await request(t.app).get('/api/v1/profiles').set(auth())).body as ProfileDto[]).find((p) => p.kind === 'kids')!;
    expect(((await request(t.app).get('/api/v1/search?q=night').set(auth(kids.id)).expect(200)).body as SearchResultDto).channels).toEqual([]);
    const vod = (await request(t.app).get('/api/v1/search?q=matr').set(auth()).expect(200)).body as SearchResultDto;
    expect(vod.movies.map((m) => m.name)).toEqual(['The Matrix']);
    expect(((await request(t.app).get('/api/v1/search?q=brea bad').set(auth())).body as SearchResultDto).series.map((s) => s.name)).toEqual(['Breaking Bad']);
    expect((await request(t.app).get('/api/v1/search?q=x').set(auth()).expect(200)).body).toMatchObject({ channels: [], movies: [] });
  });

  it('settings: defaults, validation, EPG time shift; storage and clearing data', async () => {
    const settings = (await request(t.app).get('/api/v1/me/settings').set(auth()).expect(200)).body as SettingsDto;
    expect(settings).toMatchObject({ appearance: { theme: 'system' }, epg: { timeShiftMinutes: 0 }, data: { historyRetentionDays: 180 } });
    expect((await request(t.app).patch('/api/v1/me/settings').set(auth()).send({ data: { historyRetentionDays: 7 } }).expect(400)).body.error.details).toEqual({ fields: ['data.historyRetentionDays'] });
    await request(t.app).patch('/api/v1/me/settings').set(auth()).send({ appearance: { colour: 'red' } }).expect(400);
    const before = ((await request(t.app).get('/api/v1/home').set(auth()).expect(200)).body as HomeDto).liveNow[0]!.now!;
    const updated = (await request(t.app).patch('/api/v1/me/settings').set(auth()).send({ appearance: { theme: 'light' }, epg: { timeShiftMinutes: 60 } }).expect(200)).body as SettingsDto;
    expect(updated.appearance.theme).toBe('light');
    // Every programme moves an hour later, so the one shown as "now" is the previous programme.
    const shifted = ((await request(t.app).get('/api/v1/home').set(auth()).expect(200)).body as HomeDto).liveNow[0]!;
    expect(new Date(shifted.next!.start).getTime()).toBe(new Date(before.start).getTime() + HOUR);
    expect(shifted.next!.title).toBe(before.title);
    await request(t.app).patch('/api/v1/me/settings').set(auth()).send({ epg: { timeShiftMinutes: 0 } }).expect(200);

    const usage = (await request(t.app).get('/api/v1/me/storage').set(auth()).expect(200)).body as StorageUsageDto;
    expect(usage).toMatchObject({ sources: 1, liveChannels: 4, movies: 2, series: 1, guides: 1, myList: 2 });
    expect(usage.history).toBeGreaterThanOrEqual(2);
    await request(t.app).delete('/api/v1/me/data/history').set(auth()).expect(204);
    expect(((await request(t.app).get('/api/v1/me/history').set(auth())).body as HistoryPageDto).items).toEqual([]);
    await request(t.app).delete('/api/v1/me/data/everything').set(auth()).expect(400);
  });

  it('imports per-browser favourites once and carries guest state into a new account', async () => {
    const sport = channel('Arena Sport');
    const imported = await request(t.app)
      .post('/api/v1/me/import-local')
      .set(auth())
      .send({ favorites: { [source.id]: [sport.key, 'ffffffffffff'], 'not-a-source': ['abc'] }, recents: { [source.id]: [sport.key] } })
      .expect(200);
    expect(imported.body).toEqual({ favorites: 1, recents: 1 });
    const history = (await request(t.app).get('/api/v1/me/history').set(auth())).body as HistoryPageDto;
    expect(history.items.map((i) => i.title)).toEqual(['Arena Sport']);

    const account = (await request(t.app).post('/api/v1/auth/register').set(auth()).send({ email: 'viewer@example.com', password: 'correct horse battery' }).expect(201)).body as AuthSessionDto;
    token = account.token;
    const list = (await request(t.app).get('/api/v1/me/list').set(auth()).expect(200)).body as ListStateDto;
    expect(list.items.map((i) => i.title)).toEqual(expect.arrayContaining(['Arena Sport', 'The Matrix', 'Daily News']));
    const profiles = (await request(t.app).get('/api/v1/profiles').set(auth()).expect(200)).body as ProfileDto[];
    expect(profiles.map((p) => p.name)).toEqual(['Me', 'Kids']);
  });

  it('removing a source removes its user state', async () => {
    await request(t.app).delete(`/api/v1/sources/${source.id}`).set(auth()).expect(204);
    expect(((await request(t.app).get('/api/v1/me/list').set(auth())).body as ListStateDto).items).toEqual([]);
    expect(((await request(t.app).get('/api/v1/me/history').set(auth())).body as HistoryPageDto).items).toEqual([]);
    const usage = (await request(t.app).get('/api/v1/me/storage').set(auth())).body as StorageUsageDto;
    expect(usage).toMatchObject({ sources: 0, myList: 0, progress: 0, history: 0 });
  });
});

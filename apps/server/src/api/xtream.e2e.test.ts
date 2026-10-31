import type { ServerResponse } from 'node:http';

import type { ChannelListDto, PlaybackPlanDto, SeriesDetailsDto, SessionDto, SourceDto } from '@ziptv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { binaryParser, startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';

/**
 * Xtream Codes end-to-end: a fake panel on localhost (player_api.php, get.php, stream paths),
 * the real sync pipeline, lazy episodes, playback through the proxy and M3U → Xtream conversion.
 */

const USER = 'zuser';
const PASS = 'zs3cret-pw';
const TS_PACKETS = Buffer.alloc(188 * 3, 0xff);
[0, 188, 376].forEach((offset) => (TS_PACKETS[offset] = 0x47));
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(12)]);

const calls: Record<string, number> = {};

const LIVE_CATEGORIES = [
  { category_id: '1', category_name: 'News', parent_id: 0 },
  { category_id: 2, category_name: 'Sports' },
];
const LIVE_STREAMS = [
  { num: 1, name: 'Xtream News', stream_type: 'live', stream_id: 101, stream_icon: '', epg_channel_id: 'news.xt', added: '1700000000', category_id: '1', tv_archive: 1, tv_archive_duration: '3' },
  { num: 2, name: 'Xtream Sports', stream_type: 'live', stream_id: '102', stream_icon: null, epg_channel_id: null, added: '', category_id: '2', tv_archive: 0 },
  { num: 3, name: '', stream_id: 103 }, // broken row: skipped with a warning
];
const VOD_CATEGORIES = { 0: { category_id: '10', category_name: 'Action' } }; // object instead of array
const VOD_STREAMS = [
  { num: 1, name: 'The Matrix (1999)', stream_type: 'movie', stream_id: 77, rating: '8.7', added: '1690000000', category_id: '10', container_extension: 'mp4' },
];
const SERIES_CATEGORIES = [{ category_id: '20', category_name: 'Drama' }];
const SERIES = [
  { num: 1, name: 'Breaking Bad', series_id: 9, cover: '', plot: 'A chemistry teacher…', genre: 'Crime, Drama', releaseDate: '2008-01-20', last_modified: '1695000000', rating: '9.5', category_id: '20' },
  { num: 2, name: 'Flaky Show', series_id: 10, category_id: '20' },
];
const SERIES_INFO = {
  seasons: [{ season_number: 1, name: 'Season 1' }],
  info: { name: 'Breaking Bad', plot: 'A chemistry teacher…' },
  episodes: {
    '1': [
      { id: '502', episode_num: 2, title: "Cat's in the Bag", container_extension: 'mp4', season: 1, info: { duration_secs: 2880, plot: 'Second.' } },
      { id: '501', episode_num: '1', title: 'Pilot', container_extension: 'mp4', season: '1', info: { duration_secs: '3480', movie_image: '' } },
    ],
  },
};

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function startPanel(): Promise<FakeOrigin> {
  return startOrigin((req, res) => {
    const url = new URL(req.url ?? '/', 'http://panel.local');
    const authorised = url.searchParams.get('username') === USER && url.searchParams.get('password') === PASS;
    const expiredUser = url.searchParams.get('username') === 'old' && url.searchParams.get('password') === PASS;
    switch (url.pathname) {
      case '/player_api.php': {
        const action = url.searchParams.get('action') ?? 'auth';
        calls[action] = (calls[action] ?? 0) + 1;
        if (url.searchParams.get('username') === 'getonly') {
          res.writeHead(403).end('API disabled for resellers');
          return;
        }
        if (expiredUser) {
          json(res, { user_info: { auth: 1, status: 'Expired', exp_date: '1600000000', max_connections: '1' } });
          return;
        }
        if (!authorised) {
          json(res, { user_info: { auth: 0 } });
          return;
        }
        switch (action) {
          case 'auth':
            json(res, {
              user_info: { username: USER, auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86_400 * 30), is_trial: '0', active_cons: '0', max_connections: '2', allowed_output_formats: ['m3u8', 'ts'] },
              server_info: { timezone: 'UTC' },
            });
            return;
          case 'get_live_categories':
            return json(res, LIVE_CATEGORIES);
          case 'get_live_streams':
            return json(res, LIVE_STREAMS);
          case 'get_vod_categories':
            return json(res, VOD_CATEGORIES);
          case 'get_vod_streams':
            return json(res, VOD_STREAMS);
          case 'get_series_categories':
            return json(res, SERIES_CATEGORIES);
          case 'get_series':
            return json(res, SERIES);
          case 'get_series_info':
            if (url.searchParams.get('series_id') === '10') return json(res, { error: 'down' }, 500);
            return json(res, SERIES_INFO);
          default:
            return json(res, []);
        }
      }
      case '/get.php': {
        if (url.searchParams.get('username') === 'getonly') {
          res.writeHead(200, { 'content-type': 'audio/x-mpegurl' }).end(`#EXTM3U\n#EXTINF:-1 group-title="News",Only M3U\nhttp://${req.headers.host}/live/getonly/x/1.ts\n`);
          return;
        }
        if (!authorised) {
          res.writeHead(401).end();
          return;
        }
        const base = `http://${req.headers.host}`;
        res.writeHead(200, { 'content-type': 'audio/x-mpegurl' }).end(
          [
            '#EXTM3U',
            `#EXTINF:-1 tvg-id="news.xt" tvg-name="Xtream News" group-title="News",Xtream News`,
            `${base}/live/${USER}/${PASS}/101.ts`,
            `#EXTINF:-1 tvg-name="Xtream Sports" group-title="Sports",Xtream Sports`,
            `${base}/live/${USER}/${PASS}/102.ts`,
            `#EXTINF:-1 group-title="Action",The Matrix (1999)`,
            `${base}/movie/${USER}/${PASS}/77.mp4`,
          ].join('\n'),
        );
        return;
      }
      case '/xmltv.php':
        res.writeHead(200, { 'content-type': 'application/xml' }).end('<?xml version="1.0"?><tv><channel id="news.xt"><display-name>Xtream News</display-name></channel></tv>');
        return;
      case `/live/${USER}/${PASS}/101.m3u8`:
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n/hls/abc/seg1.ts\n');
        return;
      case '/hls/abc/seg1.ts':
        res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': TS_PACKETS.length }).end(TS_PACKETS);
        return;
      case `/movie/${USER}/${PASS}/77.mp4`:
      case `/series/${USER}/${PASS}/501.mp4`:
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4.length, 'accept-ranges': 'bytes' }).end(MP4);
        return;
      default:
        res.writeHead(404).end();
    }
  });
}

describe.skipIf(!TEST_DATABASE_URL)('Xtream Codes end-to-end', () => {
  let t: TestApp;
  let panel: FakeOrigin;
  let token = '';
  let source: SourceDto;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    panel = await startPanel();
    t = await startTestApp({ JOBS_ENABLED: 'true', STREAM_DELIVERY: 'proxy' });
    t.container.jobs.start();
    token = ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token;
  });
  afterAll(async () => {
    await t?.close();
    await panel?.close();
  });

  function waitForSource(id: string, done: (source: SourceDto) => boolean): Promise<SourceDto> {
    return waitFor(async () => {
      const current = (await request(t.app).get(`/api/v1/sources/${id}`).set(auth())).body as SourceDto;
      return done(current) ? current : null;
    });
  }

  async function play(content: Record<string, unknown>): Promise<PlaybackPlanDto> {
    return (await request(t.app).post('/api/v1/playback').set(auth()).send({ content, secureContext: true }).expect(200)).body as PlaybackPlanDto;
  }

  it('syncs live, movies and series with the account state, never exposing the credentials', async () => {
    const accepted = await request(t.app)
      .post('/api/v1/sources')
      .set(auth())
      .send({ type: 'xtream', server: `${panel.url}/player_api.php`, username: USER, password: PASS })
      .expect(202);
    source = await waitForSource((accepted.body as SourceDto).id, (s) => s.revision === 1 && s.sync.status === 'idle');

    expect(source).toMatchObject({ type: 'xtream', origin: { kind: 'xtream', username: 'zu•••er' } });
    expect(source.stats).toMatchObject({ live: 2, movies: 1, series: 2, episodes: 0, catchup: 1 });
    expect(source.account).toMatchObject({ status: 'Active', maxConnections: 2, activeConnections: 0, trial: false });
    expect(source.warningCount).toBe(1);
    expect(calls['get_series_info'] ?? 0).toBe(0); // episodes are not fetched during the sync

    const live = (await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(auth()).expect(200)).body as ChannelListDto;
    expect(live.channels.map((c) => [c.name, c.groups, c.kind, c.catchupDays, c.tvgId])).toEqual([
      ['Xtream News', ['News'], 'hls', 3, 'news.xt'],
      ['Xtream Sports', ['Sports'], 'hls', null, null],
    ]);
    const everything = JSON.stringify([source, live]);
    expect(everything).not.toContain(PASS);

    const stored = await t.db.selectFrom('movies').select(['name', 'year', 'rating', 'groups', 'xtream', 'locator', 'added_at']).where('source_id', '=', source.id).execute();
    expect(stored).toEqual([{ name: 'The Matrix', year: 1999, rating: 8.7, groups: ['Action'], xtream: { id: 77, ext: 'mp4' }, locator: null, added_at: new Date(1690000000_000) }]);
  });

  it('plays a live channel as HLS through the proxy (credentials only inside the encrypted token)', async () => {
    const live = (await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(auth())).body as ChannelListDto;
    const plan = await play({ type: 'channel', sourceId: source.id, key: live.channels[0]!.key });
    expect(plan.candidates.map((c) => [c.engine, c.via])).toEqual([['hls', 'proxy']]);
    expect(JSON.stringify(plan)).not.toContain(PASS);
    expect(JSON.stringify(plan)).not.toContain(USER);

    const manifest = await request(t.app).get(plan.candidates[0]!.url).expect(200);
    const segmentRef = manifest.text.split('\n').find((line) => line && !line.startsWith('#'))!;
    const base = new URL(plan.candidates[0]!.url, 'http://api.local');
    const segment = await request(t.app).get(new URL(segmentRef, base).pathname).buffer(true).parse(binaryParser).expect(200);
    expect(Buffer.compare(segment.body as Buffer, TS_PACKETS)).toBe(0);
  });

  it('plays a movie from its container extension', async () => {
    const movie = await t.db.selectFrom('movies').select('key').where('source_id', '=', source.id).executeTakeFirstOrThrow();
    const plan = await play({ type: 'movie', sourceId: source.id, key: movie.key });
    expect(plan.content).toMatchObject({ mode: 'vod', title: 'The Matrix', subtitle: '1999' });
    expect(plan.candidates.map((c) => [c.engine, c.via])).toEqual([['native', 'proxy']]);
    const body = await request(t.app).get(plan.candidates[0]!.url).buffer(true).parse(binaryParser).expect(200);
    expect(Buffer.compare(body.body as Buffer, MP4)).toBe(0);
  });

  it('loads episodes on first open, stores them in the revision and plays them', async () => {
    const series = await t.db.selectFrom('series').select(['key', 'name']).where('source_id', '=', source.id).orderBy('position').execute();
    const breakingBad = series[0]!;

    const details = (await request(t.app).get(`/api/v1/vod/${source.id}/series/${breakingBad.key}`).set(auth()).expect(200)).body as SeriesDetailsDto;
    expect(details).toMatchObject({ name: 'Breaking Bad', year: 2008, genres: ['Crime', 'Drama'], rating: 9.5 });
    expect(details.seasons.map((s) => [s.number, s.name, s.episodes.map((e) => [e.episode, e.title, e.durationSecs])])).toEqual([
      [1, 'Season 1', [[1, 'Pilot', 3480], [2, "Cat's in the Bag", 2880]]],
    ]);
    expect(calls['get_series_info']).toBe(1);

    // Second open: served from the stored revision, no upstream call.
    await request(t.app).get(`/api/v1/vod/${source.id}/series/${breakingBad.key}`).set(auth()).expect(200);
    expect(calls['get_series_info']).toBe(1);

    const pilot = details.seasons[0]!.episodes[0]!;
    const plan = await play({ type: 'episode', sourceId: source.id, seriesKey: breakingBad.key, key: pilot.key });
    expect(plan.content).toMatchObject({ mode: 'vod', title: 'Pilot', subtitle: 'Breaking Bad · S1 E1' });
    expect(plan.next).toMatchObject({ title: "Cat's in the Bag", subtitle: 'S1 E2' });
    const body = await request(t.app).get(plan.candidates[0]!.url).buffer(true).parse(binaryParser).expect(200);
    expect(Buffer.compare(body.body as Buffer, MP4)).toBe(0);
  });

  it('reports a provider failure while loading episodes as SOURCE_UNAVAILABLE and retries on the next open', async () => {
    const flaky = await t.db.selectFrom('series').select('key').where('source_id', '=', source.id).where('name', '=', 'Flaky Show').executeTakeFirstOrThrow();
    const before = calls['get_series_info'] ?? 0;
    const failed = await request(t.app).get(`/api/v1/vod/${source.id}/series/${flaky.key}`).set(auth()).expect(502);
    expect(failed.body.error.code).toBe('SOURCE_UNAVAILABLE');
    await request(t.app).get(`/api/v1/vod/${source.id}/series/${flaky.key}`).set(auth()).expect(502);
    expect(calls['get_series_info']).toBe(before + 2);
  });

  it('classifies rejected and expired accounts', async () => {
    const wrong = (await request(t.app).post('/api/v1/sources').set(auth()).send({ type: 'xtream', server: panel.url, username: USER, password: 'nope' }).expect(202)).body as SourceDto;
    const expired = (await request(t.app).post('/api/v1/sources').set(auth()).send({ type: 'xtream', server: panel.url, username: 'old', password: PASS }).expect(202)).body as SourceDto;
    expect((await waitForSource(wrong.id, (s) => s.sync.status === 'failed')).sync.error?.problem).toBe('auth_failed');
    expect((await waitForSource(expired.id, (s) => s.sync.status === 'failed')).sync.error?.problem).toBe('expired');
    await request(t.app).delete(`/api/v1/sources/${wrong.id}`).set(auth()).expect(204);
    await request(t.app).delete(`/api/v1/sources/${expired.id}`).set(auth()).expect(204);
  });

  it('converts an Xtream M3U link into an Xtream source keeping the item keys', async () => {
    const accepted = await request(t.app)
      .post('/api/v1/sources')
      .set(auth())
      .send({ type: 'm3u_url', url: `${panel.url}/get.php?username=${USER}&password=${PASS}&type=m3u_plus&output=ts` })
      .expect(202);
    const m3u = await waitForSource((accepted.body as SourceDto).id, (s) => s.revision === 1 && s.sync.status === 'idle');
    expect(m3u.xtreamCandidate).toBe(true);
    const keysBefore = ((await request(t.app).get(`/api/v1/live/${m3u.id}/channels`).set(auth())).body as ChannelListDto).channels.map((c) => [c.name, c.key]);
    const movieBefore = await t.db.selectFrom('movies').select('key').where('source_id', '=', m3u.id).executeTakeFirstOrThrow();

    const converted = (await request(t.app).post(`/api/v1/sources/${m3u.id}/convert-to-xtream`).set(auth()).expect(202)).body as SourceDto;
    expect(converted).toMatchObject({ type: 'xtream', origin: { kind: 'xtream', username: 'zu•••er' }, xtreamCandidate: false });
    const synced = await waitForSource(m3u.id, (s) => s.revision === 2 && s.sync.status === 'idle');
    expect(synced.stats).toMatchObject({ live: 2, movies: 1, series: 2 });

    const keysAfter = ((await request(t.app).get(`/api/v1/live/${m3u.id}/channels`).set(auth())).body as ChannelListDto).channels.map((c) => [c.name, c.key]);
    expect(keysAfter).toEqual(keysBefore);
    const movieAfter = await t.db.selectFrom('movies').select('key').where('source_id', '=', m3u.id).where('revision', '=', 2).executeTakeFirstOrThrow();
    expect(movieAfter.key).toBe(movieBefore.key);

    // A panel that serves get.php but blocks the API: the switch is refused and the link kept.
    const getOnly = (await request(t.app).post('/api/v1/sources').set(auth()).send({ type: 'm3u_url', url: `${panel.url}/get.php?username=getonly&password=x` }).expect(202)).body as SourceDto;
    await waitForSource(getOnly.id, (s) => s.revision === 1 && s.sync.status === 'idle');
    const refused = await request(t.app).post(`/api/v1/sources/${getOnly.id}/convert-to-xtream`).set(auth()).expect(422);
    expect(refused.body.error.code).toBe('SOURCE_AUTH_FAILED');
    expect(((await request(t.app).get(`/api/v1/sources/${getOnly.id}`).set(auth())).body as SourceDto).type).toBe('m3u_url');

    // Only M3U URL sources are convertible.
    const again = await request(t.app).post(`/api/v1/sources/${m3u.id}/convert-to-xtream`).set(auth()).expect(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });
});

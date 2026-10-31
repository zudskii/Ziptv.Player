import type { ChannelListDto, NowNextListDto, PlaybackPlanDto, PlaylistDto, PlaylistEntryPageDto, SessionDto, SourceDto } from '@ziptv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../config/env.js';
import { binaryParser, startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';

/**
 * Commercial security model (Phase 1): with STREAM_DELIVERY=proxy no provider address,
 * credential or request header may reach a client — not in API responses, proxied manifests,
 * exported playlists, error messages or logs — and stream links die when their grant is revoked.
 */

const SECRETS = ['SECRETUSER', 'SECRETPASS', 'SECRETTOKEN', 'SecretUA'];
const TS_PACKETS = Buffer.alloc(188 * 3, 0xff);
[0, 188, 376].forEach((offset) => (TS_PACKETS[offset] = 0x47));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** XMLTV for channel `live.one`: hourly programmes around now, icons on the provider host. */
function guideXml(): string {
  const hour = 3600_000;
  const base = Math.floor(Date.now() / hour) * hour - 2 * hour;
  const time = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  const programmes = Array.from({ length: 8 }, (_, i) =>
    `<programme start="${time(base + i * hour)}" stop="${time(base + (i + 1) * hour)}" channel="live.one"><title>Morning Show ${i}</title><icon src="${providerBase}/SECRETUSER/icons/${i}.png?token=SECRETTOKEN"/></programme>`,
  );
  return `<?xml version="1.0"?><tv><channel id="live.one"><display-name>Live One</display-name><icon src="${providerBase}/SECRETUSER/icons/ch.png"/></channel>${programmes.join('')}</tv>`;
}

let providerBase = '';

async function startProvider(): Promise<FakeOrigin> {
  return startOrigin((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/SECRETUSER/guide.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' }).end(guideXml());
      return;
    }
    if (req.headers['user-agent'] !== 'SecretUA/9' && path !== '/SECRETUSER/logo.png') {
      res.writeHead(403).end();
      return;
    }
    switch (path) {
      case '/SECRETUSER/SECRETPASS/live/master.m3u8':
        res.writeHead(200).end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8?token=SECRETTOKEN\n');
        return;
      case '/SECRETUSER/SECRETPASS/live/low.m3u8':
        res.writeHead(200).end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="key?token=SECRETTOKEN"\n#EXTINF:6,\nseg1.ts?token=SECRETTOKEN\n');
        return;
      case '/SECRETUSER/SECRETPASS/movie/movie.m3u8':
        res.writeHead(200).end('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6,\nseg1.ts?token=SECRETTOKEN\n#EXT-X-ENDLIST\n');
        return;
      case '/SECRETUSER/SECRETPASS/live/seg1.ts':
      case '/SECRETUSER/SECRETPASS/movie/seg1.ts':
        res.writeHead(200, { 'content-type': 'video/mp2t' }).end(TS_PACKETS);
        return;
      case '/SECRETUSER/logo.png':
        res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
        return;
      default:
        res.writeHead(404).end();
    }
  });
}

describe.skipIf(!TEST_DATABASE_URL)('Security: proxy delivery hides providers and revokes links', () => {
  let origin: FakeOrigin;
  let t: TestApp;
  let token = '';
  let source: SourceDto;
  let channels: ChannelListDto;
  const logLines: string[] = [];
  /** Every body/header a client received during the test. */
  const seen: string[] = [];
  const bearer = (value = token) => ({ Authorization: `Bearer ${value}` });
  const record = <T extends { body: unknown; headers: Record<string, unknown>; text?: string }>(response: T): T => {
    seen.push(JSON.stringify(response.headers), typeof response.body === 'object' && !Buffer.isBuffer(response.body) ? JSON.stringify(response.body) : String(response.text ?? ''));
    return response;
  };
  const host = () => new URL(origin.url).host;

  beforeAll(async () => {
    origin = await startProvider();
    providerBase = origin.url;
    t = await startTestApp({ STREAM_DELIVERY: 'proxy', JOBS_ENABLED: 'true' }, { logLines });
    t.container.jobs.start();
    token = ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token;
    const m3u = [
      `#EXTM3U url-tvg="${origin.url}/SECRETUSER/guide.xml?token=SECRETTOKEN"`,
      `#EXTINF:-1 tvg-id="live.one" group-title="News" tvg-logo="${origin.url}/SECRETUSER/logo.png?token=SECRETTOKEN",Live One`,
      '#EXTVLCOPT:http-user-agent=SecretUA/9',
      `${origin.url}/SECRETUSER/SECRETPASS/live/master.m3u8?token=SECRETTOKEN`,
      '#EXTINF:-1 group-title="News",Dead One',
      'http://127.0.0.1:1/SECRETUSER/SECRETPASS/dead.m3u8?token=SECRETTOKEN',
      '#EXTINF:-1 group-title="Web",Web Page',
      'https://www.youtube.com/watch?v=SECRETTOKEN',
      '#EXTINF:-1 group-title="Films",VOD Movie',
      '#EXTVLCOPT:http-user-agent=SecretUA/9',
      `${origin.url}/SECRETUSER/SECRETPASS/movie/movie.m3u8`,
    ].join('\n');
    source = record(await request(t.app).post('/api/v1/sources/upload').set(bearer()).attach('file', Buffer.from(m3u), 'list.m3u').expect(201)).body as SourceDto;
  });
  afterAll(async () => {
    await t?.close();
    await origin?.close();
  });

  const plan = async (index: number, value = token): Promise<PlaybackPlanDto> =>
    record(
      await request(t.app)
        .post('/api/v1/playback')
        .set(bearer(value))
        .send({ content: { type: 'channel', sourceId: source.id, key: channels.channels[index]!.key }, secureContext: true })
        .expect(200),
    ).body as PlaybackPlanDto;

  it('channel lists carry no provider address; artwork is proxied', async () => {
    channels = record(await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(bearer()).expect(200)).body as ChannelListDto;
    expect(channels.channels.map((channel) => channel.name)).toEqual(['Live One', 'Dead One', 'Web Page']);
    const logo = channels.channels[0]!.logo!;
    expect(logo).toMatch(/^\/api\/v1\/media\/images\/t\//);
    const image = record(await request(t.app).get(logo).buffer(true).parse(binaryParser).expect(200));
    expect(image.headers['content-type']).toBe('image/png');
  });

  it('plans contain proxy candidates only, and proxied manifests are rewritten end to end', async () => {
    const live = await plan(0);
    expect(live.candidates.length).toBeGreaterThan(0);
    expect(live.candidates.every((candidate) => candidate.via === 'proxy')).toBe(true);

    const master = record(await request(t.app).get(live.candidates[0]!.url).expect(200));
    const variant = master.text.split('\n').find((line) => line && !line.startsWith('#'))!;
    const media = record(await request(t.app).get(`/api/v1/media/stream/${variant}`).expect(200));
    const segment = media.text.split('\n').find((line) => line && !line.startsWith('#'))!;
    const bytes = await request(t.app).get(`/api/v1/media/stream/${segment}`).buffer(true).parse(binaryParser).expect(200);
    expect(Buffer.compare(bytes.body as Buffer, TS_PACKETS)).toBe(0);

    // Live segments get short-lived links; the playlists keep the plan's lifetime.
    const now = Math.floor(Date.now() / 1000);
    expect(t.container.mediaTokens.verify(segment, 'stream')!.expiresAt).toBeLessThanOrEqual(now + 900);
    // Refreshing the playlist yields the same links (players match init sections/keys by URL).
    expect((await request(t.app).get(`/api/v1/media/stream/${variant}`).expect(200)).text).toBe(media.text);
    expect(t.container.mediaTokens.verify(variant, 'stream')!.expiresAt).toBeGreaterThan(now + 3600);
  });

  it('VOD playlists keep long-lived segment links (a movie is fetched over hours)', async () => {
    const page = record(await request(t.app).get(`/api/v1/live/${source.id}/channels`).set(bearer()).expect(200)).body as ChannelListDto;
    expect(page.channels).toHaveLength(3); // the movie is in the VOD library, not Live TV
    const movies = await t.db.selectFrom('movies').select('key').where('source_id', '=', source.id).execute();
    const vod = record(
      await request(t.app)
        .post('/api/v1/playback')
        .set(bearer())
        .send({ content: { type: 'movie', sourceId: source.id, key: movies[0]!.key }, secureContext: true })
        .expect(200),
    ).body as PlaybackPlanDto;
    const playlist = record(await request(t.app).get(vod.candidates[0]!.url).expect(200));
    const segment = playlist.text.split('\n').find((line) => line && !line.startsWith('#'))!;
    expect(t.container.mediaTokens.verify(segment, 'stream')!.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3600);
  });

  it('upstream failures and web-page entries do not reveal the provider', async () => {
    const dead = await plan(1);
    const failure = record(await request(t.app).get(dead.candidates[0]!.url).expect(502));
    expect(failure.body.error.message).toBe('Stream source could not be reached.');

    const web = record(
      await request(t.app)
        .post('/api/v1/playback')
        .set(bearer())
        .send({ content: { type: 'channel', sourceId: source.id, key: channels.channels[2]!.key }, secureContext: true })
        .expect(422),
    );
    expect(web.body.error.details).toEqual({ reason: 'web_page' });
  });

  it('exported playlists contain only ZIPTV proxy URLs bound to the link; revoking the link stops them', async () => {
    const playlist = record(await request(t.app).post('/api/v1/playlists').set(bearer()).send({ name: 'Mine' }).expect(201)).body as PlaylistDto;
    record(
      await request(t.app)
        .post(`/api/v1/playlists/${playlist.id}/entries/from-source`)
        .set(bearer())
        .send({ sourceId: source.id, select: { type: 'all' }, placement: { type: 'ungrouped' } })
        .expect(200),
    );
    const entries = record(await request(t.app).get(`/api/v1/playlists/${playlist.id}/entries?limit=50`).set(bearer()).expect(200)).body as PlaylistEntryPageDto;
    expect(entries.items[0]!.logo).toMatch(/^\/api\/v1\/media\/images\/t\//);

    const link = (record(await request(t.app).post(`/api/v1/playlists/${playlist.id}/export`).set(bearer()).expect(200)).body as { url: string }).url;
    const exportedResponse = await request(t.app).get(new URL(link).pathname).buffer(true).parse(binaryParser).expect(200);
    const exported = (exportedResponse.body as Buffer).toString('utf8');
    seen.push(JSON.stringify(exportedResponse.headers), exported);
    expect(exported).toContain('/api/v1/media/stream/');
    expect(exported).not.toContain('EXTVLCOPT');
    const streamUrl = exported.split('\n').find((line) => line.includes('/api/v1/media/stream/'))!;
    await request(t.app).get(new URL(streamUrl).pathname).expect(200);

    await request(t.app).delete(`/api/v1/playlists/${playlist.id}/export`).set(bearer()).expect(204);
    await request(t.app).get(new URL(streamUrl).pathname).expect(403);
  });

  it('signing out stops the stream links of that device at once', async () => {
    const other = ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token;
    await request(t.app).post('/api/v1/sources/upload').set(bearer(other)).attach('file', Buffer.from(`#EXTM3U\n#EXTINF:-1,X\n#EXTVLCOPT:http-user-agent=SecretUA/9\n${origin.url}/SECRETUSER/SECRETPASS/live/master.m3u8\n`), 'x.m3u').expect(201);
    const sources = (await request(t.app).get('/api/v1/sources').set(bearer(other)).expect(200)).body as SourceDto[];
    const list = (await request(t.app).get(`/api/v1/live/${sources[0]!.id}/channels`).set(bearer(other)).expect(200)).body as ChannelListDto;
    const otherPlan = (
      await request(t.app)
        .post('/api/v1/playback')
        .set(bearer(other))
        .send({ content: { type: 'channel', sourceId: sources[0]!.id, key: list.channels[0]!.key }, secureContext: true })
        .expect(200)
    ).body as PlaybackPlanDto;
    await request(t.app).get(otherPlan.candidates[0]!.url).expect(200);

    await request(t.app).post('/api/v1/auth/logout').set(bearer(other)).expect(204);
    const revoked = await request(t.app).get(otherPlan.candidates[0]!.url).expect(403);
    expect(revoked.body.error.message).toMatch(/revoked/);
  });

  it('EPG responses (now/next, schedule, grid, search) carry no provider address; icons are proxied', async () => {
    const now = await waitFor(async () => {
      const list = (await request(t.app).get(`/api/v1/epg/now?sourceId=${source.id}`).set(bearer()).expect(200)).body as NowNextListDto;
      return Object.keys(list.items).length > 0 ? list : null;
    });
    record({ body: now, headers: {} });
    const key = channels.channels[0]!.key;
    const current = now.items[key]!.now!;
    expect(current.icon).toMatch(/^\/api\/v1\/media\/images\/t\//);
    record(await request(t.app).get(`/api/v1/epg/channels/${source.id}/${key}`).set(bearer()).expect(200));
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3 * 3600_000).toISOString();
    record(await request(t.app).get(`/api/v1/epg/guide?sourceId=${source.id}&from=${from}&to=${to}`).set(bearer()).expect(200));
    record(await request(t.app).get(`/api/v1/epg/search?q=${encodeURIComponent('Morning')}`).set(bearer()).expect(200));
  }, 20_000);

  it('nothing the clients saw — or the logs — names the provider or its credentials', () => {
    const everything = seen.join('\n');
    for (const secret of [...SECRETS, host(), '127.0.0.1:1']) expect(everything).not.toContain(secret);
    const logs = logLines.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of ['SECRETPASS', 'SECRETTOKEN', 'SecretUA']) expect(logs).not.toContain(secret);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('Security: export modes', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ PLAYLIST_EXPORT_MODE: 'off' });
  });
  afterAll(async () => t?.close());

  it('off: no export links can be created and /p/ never answers', async () => {
    const token = ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token;
    const playlist = (await request(t.app).post('/api/v1/playlists').set({ Authorization: `Bearer ${token}` }).send({ name: 'A' }).expect(201)).body as PlaylistDto;
    await request(t.app).post(`/api/v1/playlists/${playlist.id}/export`).set({ Authorization: `Bearer ${token}` }).expect(403);
    await request(t.app).get(`/p/${'A'.repeat(43)}.m3u`).expect(404);
  });
});

describe('Security: configuration guards', () => {
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://x', STREAM_TOKEN_SECRET: 's'.repeat(40), DATA_ENCRYPTION_KEY: 'k'.repeat(40) };

  it('proxy delivery implies proxied exports and refuses contradictory settings', () => {
    expect(loadConfig({ ...base, STREAM_DELIVERY: 'proxy' }).playlistExport.mode).toBe('proxied');
    expect(loadConfig(base).playlistExport.mode).toBe('direct');
    expect(() => loadConfig({ ...base, STREAM_DELIVERY: 'proxy', PLAYLIST_EXPORT_MODE: 'direct' })).toThrow(/PLAYLIST_EXPORT_MODE/);
    expect(() => loadConfig({ ...base, STREAM_DELIVERY: 'proxy', STREAM_PROXY_ENABLED: 'false' })).toThrow(/STREAM_DELIVERY/);
    expect(() => loadConfig({ ...base, REDIS_URL: 'http://redis' })).toThrow(/REDIS_URL/);
  });
});

describe.skipIf(!TEST_DATABASE_URL || !process.env.TEST_REDIS_URL)('Security: two instances share one brute-force budget (Redis)', () => {
  let a: TestApp;
  let b: TestApp;
  beforeAll(async () => {
    a = await startTestApp({ REDIS_URL: process.env.TEST_REDIS_URL!, TRUST_PROXY: '1' });
    b = await startTestApp({ REDIS_URL: process.env.TEST_REDIS_URL!, TRUST_PROXY: '1' });
  });
  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  it('failed logins for one address are counted across replicas', async () => {
    const email = `victim-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    const attempt = (app: TestApp, i: number) =>
      request(app.app).post('/api/v1/auth/login').set('X-Forwarded-For', `198.51.${Math.floor(Math.random() * 250)}.${i}`).send({ email, password: 'wrong password 123' });
    // 10 failures per address per 15 minutes in total — not 10 per instance.
    for (let i = 0; i < 10; i++) expect((await attempt(i % 2 ? b : a, i)).status).toBe(401);
    expect((await attempt(a, 50)).status).toBe(429);
    expect((await attempt(b, 51)).status).toBe(429);
  });
});

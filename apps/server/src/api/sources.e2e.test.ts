import type { AddressInfo } from 'node:net';

import type { ChannelListDto, NotificationListDto, PlaybackPlanDto, SessionDto, SourceDto } from '@ziptv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { binaryParser, startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';

/**
 * End-to-end over real HTTP with a real PostgreSQL: the real app, proxy, upstream client and
 * background jobs talking to a fake IPTV provider on localhost.
 */

const TS_PACKETS = Buffer.alloc(188 * 3, 0xff);
[0, 188, 376].forEach((offset) => (TS_PACKETS[offset] = 0x47));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let origin: FakeOrigin;
let endlessClosed: Promise<void> = Promise.resolve();
let endlessRequests = 0;
let remoteVersion = 1;

async function startProvider(): Promise<FakeOrigin> {
  return startOrigin((req, res) => {
    const path = req.url ?? '/';
    const ua = req.headers['user-agent'];
    if (path.startsWith('/live/') && ua !== 'TestUA/1.0') {
      res.writeHead(403).end('bad ua');
      return;
    }
    if (path === '/live-endless') {
      // Endless live MPEG-TS, like an Xtream channel: never ends until the client leaves.
      endlessRequests++;
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      const timer = setInterval(() => res.write(TS_PACKETS), 20);
      endlessClosed = new Promise((resolve) =>
        req.socket.on('close', () => {
          clearInterval(timer);
          resolve();
        }),
      );
      return;
    }
    switch (path.split('?')[0]) {
      case '/redirect':
        res.writeHead(302, { location: '/live/master.m3u8' }).end();
        return;
      case '/live/master.m3u8':
        // Wrong content type on purpose — real panels do this.
        res.writeHead(200, { 'content-type': 'text/html' }).end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8\n');
        return;
      case '/live/low/index.m3u8':
        res
          .writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
          .end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n#EXTINF:6,\n/live/low/seg1.ts?abs=1\n');
        return;
      case '/live/low/seg1.ts':
        res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': TS_PACKETS.length }).end(TS_PACKETS);
        return;
      case '/xtream/user/pass/123':
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(TS_PACKETS);
        return;
      case '/remote.m3u': {
        const lines = [
          '#EXTM3U url-tvg="http://epg.example/guide.xml"',
          '#EXTINF:-1 tvg-id="one.tv" group-title="Remote" catchup="shift" catchup-days="3",Remote One',
          'streams/one.m3u8',
          '#EXTINF:5400 group-title="Movies",The Matrix (1999)',
          'http://vod.example/movie/u/p/77.mp4',
          '#EXTINF:2700 group-title="Series",Breaking Bad S01E01 Pilot',
          'http://vod.example/series/u/p/501.mkv',
          '#EXTINF:2700 group-title="Series",Breaking Bad S01E02 Cat\'s in the Bag',
          'http://vod.example/series/u/p/502.mkv',
        ];
        if (remoteVersion > 1) lines.push('#EXTINF:-1 group-title="Remote",Remote Two', 'streams/two.m3u8');
        res.writeHead(200, { 'content-type': 'audio/x-mpegurl' }).end(lines.join('\n'));
        return;
      }
      case '/auth.m3u':
        res.writeHead(401).end('unauthorized');
        return;
      case '/gone.m3u':
        res.writeHead(404).end('nope');
        return;
      case '/logo.png':
        res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
        return;
      default:
        res.writeHead(404).end();
    }
  });
}

describe.skipIf(!TEST_DATABASE_URL)('Sources & Live TV end-to-end', () => {
  let t: TestApp;
  let token = '';
  let file: SourceDto;
  let channels: ChannelListDto;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    origin = await startProvider();
    t = await startTestApp({ JOBS_ENABLED: 'true' });
    t.container.jobs.start();
  });
  afterAll(async () => {
    await t?.close();
    await origin?.close();
  });

  it('creates an anonymous session and rejects unauthenticated calls', async () => {
    const created = await request(t.app).post('/api/v1/sessions').send({}).expect(201);
    token = (created.body as SessionDto).token;
    expect(token).toMatch(/^[\w-]{43}$/);

    const denied = await request(t.app).get('/api/v1/sources').expect(401);
    expect(denied.body.error.code).toBe('UNAUTHORIZED');
    await request(t.app).get('/api/v1/sessions/me').set(auth()).expect(200);
  });

  it('uploads an M3U file as a source (parsed in-request)', async () => {
    const m3u = [
      '#EXTM3U',
      `#EXTINF:-1 group-title="News" tvg-logo="${origin.url}/logo.png",Proxy Me`,
      `${origin.url}/redirect|User-Agent=TestUA/1.0`,
      '#EXTINF:-1 group-title="Xtream",Extensionless',
      `${origin.url}/xtream/user/pass/123`,
      '#EXTINF:-1,RTMP Channel',
      'rtmp://example.com/live/x',
      '#EXTINF:-1,Endless',
      `${origin.url}/live-endless`,
    ].join('\n');

    const response = await request(t.app)
      .post('/api/v1/sources/upload')
      .set(auth())
      .field('name', 'Test list')
      .attach('file', Buffer.from(m3u), { filename: 'list.m3u8', contentType: 'application/octet-stream' })
      .expect(201);
    file = response.body as SourceDto;
    expect(file).toMatchObject({
      name: 'Test list',
      type: 'm3u_file',
      origin: { kind: 'file', fileName: 'list.m3u8' },
      revision: 1,
      sync: { status: 'idle', autoSync: false },
      stats: { live: 4, movies: 0, series: 0, groups: 2, unplayable: 1 },
    });

    const list = (await request(t.app).get('/api/v1/sources').set(auth()).expect(200)).body as SourceDto[];
    expect(list.map((source) => source.id)).toEqual([file.id]);
  });

  it('serves the channel list with a version ETag (304 on repeat) and never leaks stream URLs', async () => {
    const response = await request(t.app).get(`/api/v1/live/${file.id}/channels`).set(auth()).expect(200);
    channels = response.body as ChannelListDto;
    expect(channels.catalogVersion).toBe(file.catalogVersion);
    expect(channels.channels.map((c) => [c.name, c.groups, c.kind, c.locked])).toEqual([
      ['Proxy Me', ['News'], 'unknown', false],
      ['Extensionless', ['Xtream'], 'unknown', false],
      ['RTMP Channel', [], 'unknown', false],
      ['Endless', [], 'unknown', false],
    ]);
    expect(JSON.stringify(channels)).not.toContain('/xtream/');

    await request(t.app)
      .get(`/api/v1/live/${file.id}/channels`)
      .set({ ...auth(), 'If-None-Match': response.headers.etag as string })
      .expect(304);
  });

  it('plays an HLS stream that needs a User-Agent through the rewriting proxy (redirect + relative URIs)', async () => {
    const plan = await resolve(0, true);
    expect(plan.content).toMatchObject({ mode: 'live', title: 'Proxy Me', channel: { kind: 'hls' } });
    expect(plan.candidates.map((c) => [c.engine, c.via])).toEqual([['hls', 'proxy']]);

    const master = await request(t.app).get(plan.candidates[0]!.url).expect(200);
    expect(master.headers['content-type']).toContain('mpegurl');
    expect(master.headers['access-control-allow-origin']).toBe('*');
    const variantRef = master.text.split('\n')[2]!;
    expect(variantRef).not.toMatch(/[/:]/); // relative token reference

    const base = new URL(plan.candidates[0]!.url, 'http://api.local');
    const variant = await request(t.app).get(new URL(variantRef, base).pathname).expect(200);
    const segmentRefs = variant.text.split('\n').filter((line) => line && !line.startsWith('#'));
    expect(segmentRefs).toHaveLength(2);

    for (const ref of segmentRefs) {
      const segment = await request(t.app).get(new URL(ref, base).pathname).buffer(true).parse(binaryParser).expect(200);
      expect(Buffer.compare(segment.body as Buffer, TS_PACKETS)).toBe(0);
      expect(segment.headers['content-type']).toBe('video/mp2t');
    }
  });

  it('probes extension-less URLs and pipes MPEG-TS', async () => {
    const plan = await resolve(1, false);
    expect(plan.content.channel?.kind).toBe('mpegts');
    expect(plan.candidates.map((c) => [c.engine, c.via])).toEqual([
      ['mpegts', 'direct'],
      ['mpegts', 'proxy'],
    ]);
    const stream = await request(t.app).get(plan.candidates[1]!.url).buffer(true).parse(binaryParser).expect(200);
    expect(Buffer.compare(stream.body as Buffer, TS_PACKETS)).toBe(0);
  });

  it('survives endless live streams: probe stops early, viewer disconnect aborts upstream', async () => {
    const plan = await resolve(3, true);
    expect(plan.content.channel?.kind).toBe('mpegts');
    await endlessClosed; // the probe closed its upstream connection after sniffing
    const probeRequests = endlessRequests;

    const server = t.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${plan.candidates[0]!.url}`);
    const reader = response.body!.getReader();
    let received = 0;
    while (received < TS_PACKETS.length * 3) received += (await reader.read()).value?.length ?? 0;
    expect(endlessRequests).toBe(probeRequests + 1);

    await reader.cancel(); // viewer closes the tab
    await endlessClosed; // …and the proxy tears down the upstream connection
    server.closeAllConnections();
    server.close();
  });

  it('explains unplayable channels and rejects forged proxy tokens', async () => {
    const response = await request(t.app)
      .post('/api/v1/playback')
      .set(auth())
      .send({ content: { type: 'channel', sourceId: file.id, key: channels.channels[2]!.key }, secureContext: true })
      .expect(422);
    expect(response.body.error).toMatchObject({ code: 'UNPLAYABLE', details: { reason: 'unsupported_protocol' } });

    const expiry = Math.floor(Date.now() / 1000) + 60;
    const forged = t.container.mediaTokens.issue(`${origin.url}/live/master.m3u8`, undefined, expiry, { kind: 'session', id: 'no-such-session' });
    await request(t.app).get(`/api/v1/media/stream/${forged.slice(0, -2)}xx`).expect(403);
    // A well-formed token for a device that is not signed in (any more) is refused too.
    expect((await request(t.app).get(`/api/v1/media/stream/${forged}`).expect(403)).body.error.message).toMatch(/revoked/);
    // An image token cannot be used as a stream token.
    await request(t.app).get(`/api/v1/media/stream/${t.container.mediaTokens.issueImage(`${origin.url}/logo.png`)}`).expect(403);
  });

  it('proxies catalog images (and 2.x logo URLs) with safe headers', async () => {
    const key = channels.channels[0]!.key;
    for (const path of [`/api/v1/media/images/${file.id}/channel/${key}`, `/api/v1/media/logos/${file.id}/${key}`]) {
      const logo = await request(t.app).get(path).buffer(true).parse(binaryParser).expect(200);
      expect(logo.headers['content-type']).toBe('image/png');
      expect(logo.headers['content-security-policy']).toContain('sandbox');
    }
    await request(t.app).get(`/api/v1/media/images/${file.id}/channel/${channels.channels[1]!.key}`).expect(404);
    const signed = await request(t.app)
      .get(`/api/v1/media/images/t/${t.container.mediaTokens.issueImage(`${origin.url}/logo.png`)}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(signed.headers['content-type']).toBe('image/png');
  });

  it('adds a URL source, syncs it in the background into Live TV / Movies / Series, and re-syncs on demand', async () => {
    const accepted = await request(t.app)
      .post('/api/v1/sources')
      .set(auth())
      .send({ type: 'm3u_url', url: `${origin.url}/remote.m3u?username=u&password=p` })
      .expect(202);
    const queued = accepted.body as SourceDto;
    expect(queued).toMatchObject({ type: 'm3u_url', revision: 0, origin: { kind: 'url' } });
    expect(['queued', 'running', 'idle']).toContain(queued.sync.status);
    expect(JSON.stringify(queued)).not.toContain('password=p');

    const synced = await waitForSource(queued.id, (source) => source.revision === 1 && source.sync.status === 'idle');
    expect(synced.stats).toMatchObject({ live: 1, movies: 1, series: 1, episodes: 2, catchup: 1 });
    expect(synced.sync.lastSuccessAt).not.toBeNull();
    expect(synced.sync.nextSyncAt).not.toBeNull();

    const live = (await request(t.app).get(`/api/v1/live/${queued.id}/channels`).set(auth()).expect(200)).body as ChannelListDto;
    expect(live.channels).toEqual([expect.objectContaining({ name: 'Remote One', catchupDays: 3, tvgId: 'one.tv' })]);

    remoteVersion = 2;
    await request(t.app).post(`/api/v1/sources/${queued.id}/sync`).set(auth()).expect(202);
    const resynced = await waitForSource(queued.id, (source) => source.revision === 2 && source.sync.status === 'idle');
    expect(resynced.stats.live).toBe(2);

    const notifications = (await request(t.app).get('/api/v1/notifications').set(auth()).expect(200)).body as NotificationListDto;
    expect(notifications.items.map((n) => n.type)).toEqual(expect.arrayContaining(['source_synced', 'channels_added']));
    expect(notifications.items.find((n) => n.type === 'channels_added')?.body).toContain('1 new channel');
    expect(notifications.unread).toBeGreaterThan(0);
    await request(t.app).post('/api/v1/notifications/read').set(auth()).send({ ids: 'all' }).expect(204);
    expect(((await request(t.app).get('/api/v1/notifications').set(auth())).body as NotificationListDto).unread).toBe(0);
  });

  it('classifies sync failures (authentication failed / playlist expired)', async () => {
    const auth401 = (await request(t.app).post('/api/v1/sources').set(auth()).send({ type: 'm3u_url', url: `${origin.url}/auth.m3u` }).expect(202)).body as SourceDto;
    const gone404 = (await request(t.app).post('/api/v1/sources').set(auth()).send({ type: 'm3u_url', url: `${origin.url}/gone.m3u` }).expect(202)).body as SourceDto;
    const failedAuth = await waitForSource(auth401.id, (source) => source.sync.status === 'failed');
    const failedGone = await waitForSource(gone404.id, (source) => source.sync.status === 'failed');
    expect(failedAuth.sync.error?.problem).toBe('auth_failed');
    expect(failedGone.sync.error?.problem).toBe('expired');
    expect(failedAuth.sync.nextSyncAt).not.toBeNull(); // retried later with backoff

    const notifications = (await request(t.app).get('/api/v1/notifications').set(auth()).expect(200)).body as NotificationListDto;
    expect(notifications.items.filter((n) => n.type === 'source_failed')).toHaveLength(2);
  });

  it('isolates users and deletes sources with their catalog', async () => {
    const other = (await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto;
    await request(t.app).get(`/api/v1/live/${file.id}/channels`).set({ Authorization: `Bearer ${other.token}` }).expect(404);
    await request(t.app).delete(`/api/v1/sources/${file.id}`).set({ Authorization: `Bearer ${other.token}` }).expect(404);

    await request(t.app).delete(`/api/v1/sources/${file.id}`).set(auth()).expect(204);
    await request(t.app).get(`/api/v1/live/${file.id}/channels`).set(auth()).expect(404);
    await request(t.app).get(`/api/v1/media/images/${file.id}/channel/${channels.channels[0]!.key}`).expect(404);
  });

  it('maps framework 4xx errors and validation failures to the API error shape', async () => {
    const malformed = await request(t.app).post('/api/v1/sources').set(auth()).set('Content-Type', 'application/json').send('{bad').expect(400);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
    const missing = await request(t.app).get('/api/v1/nope').expect(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    const invalid = await request(t.app).post('/api/v1/sources').set(auth()).send({ type: 'm3u_url', url: 'ftp://nope' }).expect(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    const empty = await request(t.app)
      .post('/api/v1/sources/upload')
      .set(auth())
      .attach('file', Buffer.from('#EXTM3U\n# nothing here\n'), 'empty.m3u')
      .expect(422);
    expect(empty.body.error.code).toBe('SOURCE_EMPTY');
    const html = await request(t.app).post('/api/v1/sources/upload').set(auth()).attach('file', Buffer.from('<!doctype html><html></html>'), 'x.m3u').expect(422);
    expect(html.body.error.code).toBe('SOURCE_INVALID');
    // Rejected uploads leave no broken source behind.
    const list = (await request(t.app).get('/api/v1/sources').set(auth())).body as SourceDto[];
    expect(list.every((source) => source.revision > 0 || source.type !== 'm3u_file')).toBe(true);
  });

  async function resolve(index: number, secureContext: boolean): Promise<PlaybackPlanDto> {
    const response = await request(t.app)
      .post('/api/v1/playback')
      .set(auth())
      .send({ content: { type: 'channel', sourceId: file.id, key: channels.channels[index]!.key }, secureContext })
      .expect(200);
    return response.body as PlaybackPlanDto;
  }

  function waitForSource(id: string, done: (source: SourceDto) => boolean): Promise<SourceDto> {
    return waitFor(async () => {
      const source = (await request(t.app).get(`/api/v1/sources/${id}`).set(auth())).body as SourceDto;
      return done(source) ? source : null;
    });
  }
});

describe.skipIf(!TEST_DATABASE_URL)('SSRF protection on a public deployment', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ ALLOW_PRIVATE_UPSTREAMS: 'false' });
  });
  afterAll(() => t?.close());

  it('refuses sources on loopback/private addresses', async () => {
    const { token } = (await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto;
    for (const url of ['http://127.0.0.1:1/list.m3u', 'http://localhost/list.m3u', 'http://169.254.169.254/latest/meta-data']) {
      const response = await request(t.app).post('/api/v1/sources').set({ Authorization: `Bearer ${token}` }).send({ type: 'm3u_url', url }).expect(422);
      expect(response.body.error.code).toBe('UPSTREAM_BLOCKED');
    }
  });
});

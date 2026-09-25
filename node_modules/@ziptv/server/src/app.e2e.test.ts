import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ChannelListDto, PlaybackPlanDto, PlaylistDto, SessionDto } from '@ziptv/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { buildContainer, type Container } from './container.js';
import { createLogger } from './infrastructure/logger.js';
import { InMemoryChannelRepository, InMemoryPlaylistRepository, InMemoryUserRepository } from './test/in-memory-repositories.js';

/**
 * End-to-end over real HTTP: the real app, real proxy and real upstream client talking to a
 * fake IPTV origin on localhost. Only persistence is swapped for in-memory adapters.
 */

const TS_PACKETS = Buffer.alloc(188 * 3, 0xff);
[0, 188, 376].forEach((offset) => (TS_PACKETS[offset] = 0x47));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let origin: Server;
let originUrl: string;
/** Resolves when the origin sees the endless stream's socket close (upstream abort propagated). */
let endlessClosed: Promise<void> = Promise.resolve();
let endlessRequests = 0;

function startOrigin(): Promise<void> {
  origin = createServer((req, res) => {
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
      endlessClosed = new Promise((resolve) => req.socket.on('close', () => { clearInterval(timer); resolve(); }));
      return;
    }
    switch (path) {
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
      case '/live/low/seg1.ts?abs=1':
        res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': TS_PACKETS.length }).end(TS_PACKETS);
        return;
      case '/xtream/user/pass/123':
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(TS_PACKETS);
        return;
      case '/remote.m3u':
        res.writeHead(200, { 'content-type': 'audio/x-mpegurl' }).end('#EXTM3U\n#EXTINF:-1 group-title="Remote",Remote One\nstreams/one.m3u8\n');
        return;
      case '/logo.png':
        res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
        return;
      default:
        res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    origin.listen(0, '127.0.0.1', () => {
      originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

function buildTestApp(env: Record<string, string> = {}): { app: ReturnType<typeof createApp>; container: Container } {
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGO_URI: 'mongodb://unused',
    STREAM_TOKEN_SECRET: 's'.repeat(40),
    ALLOW_PRIVATE_UPSTREAMS: 'true',
    CORS_ORIGINS: 'http://localhost:5173',
    ...env,
  });
  const logger = createLogger({ log: { level: 'silent' }, env: 'test' });
  const container = buildContainer(config, logger, {
    users: new InMemoryUserRepository(),
    playlists: new InMemoryPlaylistRepository(),
    channels: new InMemoryChannelRepository(),
  });
  return { app: createApp({ config, logger, container, isReady: () => true }), container };
}

describe('HTTP API end-to-end', () => {
  const { app, container } = buildTestApp();
  let token = '';
  let playlist: PlaylistDto;
  let channels: ChannelListDto;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(startOrigin);
  afterAll(async () => {
    origin.close();
    await container.dispose();
  });

  it('creates an anonymous session and rejects unauthenticated calls', async () => {
    const created = await request(app).post('/api/v1/sessions').send({}).expect(201);
    token = (created.body as SessionDto).token;
    expect(token).toMatch(/^[\w-]{43}$/);

    const denied = await request(app).get('/api/v1/playlists').expect(401);
    expect(denied.body.error.code).toBe('UNAUTHORIZED');
    await request(app).get('/api/v1/sessions/me').set(auth()).expect(200);
  });

  it('uploads a playlist with headers, unknown containers and unplayable entries', async () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="News" tvg-logo="' + originUrl + '/logo.png",Proxy Me',
      `${originUrl}/redirect|User-Agent=TestUA/1.0`,
      '#EXTINF:-1 group-title="Xtream",Extensionless',
      `${originUrl}/xtream/user/pass/123`,
      '#EXTINF:-1,RTMP Channel',
      'rtmp://example.com/live/x',
      '#EXTINF:-1,Endless',
      `${originUrl}/live-endless`,
    ].join('\n');

    const response = await request(app)
      .post('/api/v1/playlists/upload')
      .set(auth())
      .field('name', 'Test list')
      .attach('file', Buffer.from(m3u), { filename: 'list.m3u8', contentType: 'application/octet-stream' })
      .expect(201);
    playlist = response.body as PlaylistDto;
    expect(playlist).toMatchObject({ name: 'Test list', revision: 1, stats: { channels: 4, groups: 2, unplayable: 1 } });
  });

  it('serves the channel list with a revision ETag (304 on repeat)', async () => {
    const response = await request(app).get(`/api/v1/playlists/${playlist.id}/channels`).set(auth()).expect(200);
    channels = response.body as ChannelListDto;
    expect(channels.channels.map((c) => [c.name, c.groups, c.kind])).toEqual([
      ['Proxy Me', ['News'], 'unknown'],
      ['Extensionless', ['Xtream'], 'unknown'],
      ['RTMP Channel', [], 'unknown'],
      ['Endless', [], 'unknown'],
    ]);
    expect(JSON.stringify(channels)).not.toContain('/xtream/'); // stream URLs never leak in lists

    await request(app)
      .get(`/api/v1/playlists/${playlist.id}/channels`)
      .set({ ...auth(), 'If-None-Match': response.headers.etag as string })
      .expect(304);
  });

  it('plays an HLS stream that needs a User-Agent through the rewriting proxy (redirect + relative URIs)', async () => {
    const plan = await resolve(0, true);
    expect(plan.candidates.map((c) => [c.engine, c.via])).toEqual([['hls', 'proxy']]);

    const master = await request(app).get(plan.candidates[0]!.url).expect(200);
    expect(master.headers['content-type']).toContain('mpegurl');
    expect(master.headers['access-control-allow-origin']).toBe('*');
    const variantRef = master.text.split('\n')[2]!;
    expect(variantRef).not.toMatch(/[/:]/); // relative token reference

    const base = new URL(plan.candidates[0]!.url, 'http://api.local');
    const variant = await request(app).get(new URL(variantRef, base).pathname).expect(200);
    const segmentRefs = variant.text.split('\n').filter((line) => line && !line.startsWith('#'));
    expect(segmentRefs).toHaveLength(2);

    for (const ref of segmentRefs) {
      const segment = await request(app).get(new URL(ref, base).pathname).buffer(true).parse(binaryParser).expect(200);
      expect(Buffer.compare(segment.body as Buffer, TS_PACKETS)).toBe(0);
      expect(segment.headers['content-type']).toBe('video/mp2t');
    }
  });

  it('probes extension-less URLs and pipes MPEG-TS', async () => {
    const plan = await resolve(1, false);
    expect(plan.channel.kind).toBe('mpegts');
    expect(plan.candidates.map((c) => [c.engine, c.via])).toEqual([
      ['mpegts', 'direct'],
      ['mpegts', 'proxy'],
    ]);
    const stream = await request(app).get(plan.candidates[1]!.url).buffer(true).parse(binaryParser).expect(200);
    expect(Buffer.compare(stream.body as Buffer, TS_PACKETS)).toBe(0);
  });

  it('survives endless live streams: probe stops early, viewer disconnect aborts upstream', async () => {
    const plan = await resolve(3, true);
    expect(plan.channel.kind).toBe('mpegts');
    await endlessClosed; // the probe closed its upstream connection after sniffing
    const probeRequests = endlessRequests;

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${plan.candidates[0]!.url}`);
    const reader = response.body!.getReader();
    let received = 0;
    while (received < TS_PACKETS.length * 3) received += (await reader.read()).value?.length ?? 0;
    expect(endlessRequests).toBe(probeRequests + 1);

    await reader.cancel(); // viewer closes the tab
    await endlessClosed; // …and the proxy tears down the upstream connection
    server.close();
  });

  it('explains unplayable channels and rejects forged proxy tokens', async () => {
    const response = await request(app)
      .post('/api/v1/playback')
      .set(auth())
      .send({ playlistId: playlist.id, channelKey: channels.channels[2]!.key, secureContext: true })
      .expect(422);
    expect(response.body.error).toMatchObject({ code: 'UNPLAYABLE', details: { reason: 'unsupported_protocol' } });

    const forged = container.tokens.issue(`${originUrl}/live/master.m3u8`, undefined, Math.floor(Date.now() / 1000) + 60);
    await request(app).get(`/api/v1/media/stream/${forged.slice(0, -2)}xx`).expect(403);
  });

  it('proxies channel logos with safe headers', async () => {
    const logo = await request(app)
      .get(`/api/v1/media/logos/${playlist.id}/${channels.channels[0]!.key}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.headers['content-security-policy']).toContain('sandbox');
    await request(app).get(`/api/v1/media/logos/${playlist.id}/${channels.channels[1]!.key}`).expect(404);
  });

  it('imports from a URL (relative entries resolved) and refreshes atomically', async () => {
    const imported = await request(app).post('/api/v1/playlists/import').set(auth()).send({ url: `${originUrl}/remote.m3u` }).expect(201);
    const remote = imported.body as PlaylistDto;
    expect(remote).toMatchObject({ source: { type: 'url' }, stats: { channels: 1 }, revision: 1 });

    const refreshed = await request(app).post(`/api/v1/playlists/${remote.id}/refresh`).set(auth()).expect(200);
    expect(refreshed.body.revision).toBe(2);

    await request(app).post(`/api/v1/playlists/${playlist.id}/refresh`).set(auth()).expect(409);
  });

  it('isolates users and deletes playlists with their channels', async () => {
    const other = (await request(app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto;
    await request(app).get(`/api/v1/playlists/${playlist.id}/channels`).set({ Authorization: `Bearer ${other.token}` }).expect(404);
    await request(app).delete(`/api/v1/playlists/${playlist.id}`).set({ Authorization: `Bearer ${other.token}` }).expect(404);

    await request(app).delete(`/api/v1/playlists/${playlist.id}`).set(auth()).expect(204);
    await request(app).get(`/api/v1/playlists/${playlist.id}/channels`).set(auth()).expect(404);
  });

  it('maps framework 4xx errors (malformed JSON, unknown routes) to the API error shape', async () => {
    const malformed = await request(app).post('/api/v1/playlists/import').set(auth()).set('Content-Type', 'application/json').send('{bad').expect(400);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
    const missing = await request(app).get('/api/v1/nope').expect(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('returns structured validation errors', async () => {
    const response = await request(app).post('/api/v1/playlists/import').set(auth()).send({ url: 'ftp://nope' }).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    const empty = await request(app)
      .post('/api/v1/playlists/upload')
      .set(auth())
      .attach('file', Buffer.from('#EXTM3U\n# nothing here\n'), 'empty.m3u')
      .expect(422);
    expect(empty.body.error.code).toBe('PLAYLIST_EMPTY');
  });

  async function resolve(index: number, secureContext: boolean): Promise<PlaybackPlanDto> {
    const response = await request(app)
      .post('/api/v1/playback')
      .set(auth())
      .send({ playlistId: playlist.id, channelKey: channels.channels[index]!.key, secureContext })
      .expect(200);
    return response.body as PlaybackPlanDto;
  }
});

describe('SSRF protection on a public deployment', () => {
  const { app, container } = buildTestApp({ ALLOW_PRIVATE_UPSTREAMS: 'false' });
  afterAll(() => container.dispose());

  it('refuses to import playlists from loopback/private addresses', async () => {
    const { token } = (await request(app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto;
    for (const url of ['http://127.0.0.1:1/list.m3u', 'http://localhost/list.m3u', 'http://169.254.169.254/latest/meta-data']) {
      const response = await request(app).post('/api/v1/playlists/import').set({ Authorization: `Bearer ${token}` }).send({ url }).expect(422);
      expect(response.body.error.code).toBe('UPSTREAM_BLOCKED');
    }
  });
});

/** Collects a binary body (supertest's default parsers only handle text/JSON). */
const binaryParser = ((res: NodeJS.ReadableStream, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
  res.on('error', (error: Error) => callback(error, Buffer.alloc(0)));
}) as unknown as (res: request.Response, callback: (error: Error | null, body: unknown) => void) => void;

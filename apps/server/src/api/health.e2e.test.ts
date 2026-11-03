import { createHmac } from 'node:crypto';

import type {
  AdminLoginResponse,
  AdminSessionDto,
  AuditPageDto,
  ChannelFailoverDto,
  FeedHealthPageDto,
  IncidentPageDto,
  MasterChannelDetailDto,
  PlaybackPlanDto,
  ProbeResultDto,
  ProviderDto,
  SessionDto,
  SourceDto,
} from '@ziptv/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Clock } from '../application/ports/clock.js';
import { totpCode, totpStep } from '../domain/admin/totp.js';
import { newEntityId } from '../domain/shared/ids.js';
import { ScryptPasswordHasher } from '../infrastructure/crypto/password-hasher.js';
import { createLogger } from '../infrastructure/logger.js';
import { PgAdminUnitOfWork } from '../infrastructure/persistence/postgres/repositories/admin.repository.js';
import { PgHealthRepository } from '../infrastructure/persistence/postgres/repositories/health.repository.js';
import { startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';
import { createAdminApp } from './admin/admin-app.js';

/**
 * Stream health and failover end to end (Phase 7, ZP-ENT-06). A fake origin serves two live HLS
 * feeds of one master channel (two providers). Probes run against it with a controllable clock:
 * a broken primary fails over to the backup (journaled, alert sent, incident opened), a frozen
 * playlist counts as a failure although it answers 200, recovery fails back only after the
 * cooldown, and an operator pin overrides automatic failover (audited).
 */

const TS = Buffer.alloc(188 * 4, 0xff);
[0, 188, 376, 564].forEach((offset) => (TS[offset] = 0x47));
const PASSWORD = 'initial-password-123';
const WEBHOOK_SECRET = 'webhook-secret-for-tests';

describe.skipIf(!TEST_DATABASE_URL)('Stream health and failover', { timeout: 60_000 }, () => {
  let t: TestApp;
  let admin: Express;
  let origin: FakeOrigin;
  let staff = '';
  let viewer = '';
  let offsetMs = 0;
  const clock: Clock = { now: () => new Date(Date.now() + offsetMs) };
  const feedState = { a: { broken: false, frozen: false, seq: 100 }, b: { broken: false, frozen: false, seq: 500 } };
  let listBroken = false;
  const hooks: { body: string; signature: string | undefined; delivery: string | undefined }[] = [];

  const ops = () => ({ Authorization: `Bearer ${staff}` });
  const as = () => ({ Authorization: `Bearer ${viewer}` });
  let channelId = '';
  let feedA = '';
  let feedB = '';

  beforeAll(async () => {
    origin = await startOrigin((req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      if (path === '/hook') {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          hooks.push({ body, signature: req.headers['x-ziptv-signature'] as string | undefined, delivery: req.headers['x-ziptv-delivery'] as string | undefined });
          res.writeHead(204).end();
        });
        return;
      }
      if (path === '/list.m3u') {
        if (listBroken) return void res.writeHead(503).end();
        return void res.writeHead(200, { 'content-type': 'audio/x-mpegurl' }).end(`#EXTM3U\n#EXTINF:-1 tvg-id="news.tv",Daily News\nhttp://${req.headers.host}/a/index.m3u8\n`);
      }
      const match = /^\/([ab])\/(index\.m3u8|seg\d+\.ts)$/.exec(path);
      if (!match) return void res.writeHead(404).end();
      const feed = feedState[match[1] as 'a' | 'b'];
      if (feed.broken) return void res.writeHead(503).end('down');
      if (match[2] === 'index.m3u8') {
        if (!feed.frozen) feed.seq++;
        return void res
          .writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
          .end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${feed.seq}\n#EXTINF:6,\nseg${feed.seq}.ts\n#EXTINF:6,\nseg${feed.seq + 1}.ts\n`);
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' }).end(TS);
    });
    t = await startTestApp(
      {
        JOBS_ENABLED: 'true',
        OPERATOR_ACCESS: 'rights',
        PROBES_ENABLED: 'true',
        PROBE_REGION: 'eu-central',
        PROBE_REGIONS: 'eu-central,us-east',
        PROBE_INTERVAL_SECONDS: '10',
        PROBE_FAILING_INTERVAL_SECONDS: '5',
        PROBE_DECODE_EVERY_HOURS: '0',
        HEALTH_FAIL_AFTER: '2',
        HEALTH_RECOVER_AFTER: '2',
        FAILOVER_COOLDOWN_MINUTES: '1',
        ALERT_WEBHOOK_URL: 'http://placeholder.invalid/hook',
        ALERT_WEBHOOK_SECRET: WEBHOOK_SECRET,
        METRICS_TOKEN: 'metrics-token-for-tests',
        OPERATOR_DEFAULT_COUNTRY: 'GE',
      },
      { clock },
    );
    // The webhook must point at the fake origin, known only once it listens.
    (t.config.alerts as { webhookUrl: string | null }).webhookUrl = `${origin.url}/hook`;
    t.container.jobs.start();
    admin = createAdminApp({ config: t.config, logger: createLogger({ log: { level: 'silent' }, env: 'test' }), container: t.container });

    const hash = await new ScryptPasswordHasher({ N: 2 ** 10, r: 8, p: 1 }, 4).hash(PASSWORD);
    await new PgAdminUnitOfWork(t.db).run((tx) => tx.staff.create({ id: newEntityId(), email: 'noc@ops.example', name: 'NOC', role: 'SUPER_ADMIN', passwordHash: hash, now: new Date() }));
    const login = (await request(admin).post('/admin/v1/auth/login').send({ email: 'noc@ops.example', password: PASSWORD }).expect(200)).body as AdminLoginResponse;
    if (login.step !== 'enroll') throw new Error('expected enrolment');
    staff = ((await request(admin).post('/admin/v1/auth/mfa').send({ challenge: login.challenge, code: totpCode(login.secret, totpStep(Date.now())) }).expect(200)).body as AdminSessionDto).token;
    await request(admin).post('/admin/v1/auth/password').set(ops()).send({ currentPassword: PASSWORD, newPassword: 'noc-passphrase-is-long' }).expect(204);
    viewer = ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token;
  });
  afterAll(async () => {
    await t?.close();
    await origin?.close();
  });

  /** Moves the clock and lets the probe fleet (and the given jobs) run. */
  const tick = (secs: number, ...jobs: string[]) => {
    offsetMs += secs * 1000;
    for (const job of ['feed-probe', ...jobs]) t.container.jobs.kick(job);
  };
  const until = <T>(probe: () => Promise<T | null | undefined | false>, step = 6, ...jobs: string[]) =>
    waitFor(async () => {
      tick(step, ...jobs);
      return probe();
    }, 30_000, 250);
  const feeds = async () => ((await request(admin).get(`/admin/v1/monitoring/feeds?channelId=${channelId}`).set(ops()).expect(200)).body as FeedHealthPageDto).items;
  const status = async (feedId: string) => (await feeds()).find((feed) => feed.feedId === feedId)?.status;
  const failover = async () => (await request(admin).get(`/admin/v1/monitoring/channels/${channelId}/failover`).set(ops()).expect(200)).body as ChannelFailoverDto;
  const plan = async () => (await request(t.app).post('/api/v1/playback').set(as()).send({ content: { type: 'operator', channelId }, secureContext: false }).expect(200)).body as PlaybackPlanDto;
  /** Which feed a candidate is (its telemetry token names it). */
  const feedOf = (token: string | undefined) => {
    const hex = /^f([0-9a-f]{32})\./.exec(token ?? '')?.[1] ?? '';
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };

  it('probes both feeds of a channel and makes the primary active', async () => {
    const channel = (await request(admin).post('/admin/v1/channels').set(ops()).send({ name: 'Daily News', globalUid: 'news.tv' }).expect(201)).body as MasterChannelDetailDto;
    channelId = channel.id;
    const mock = (name: string, path: string) => request(admin).post('/admin/v1/providers').set(ops()).send({ name, type: 'mock', config: { channels: [{ id: 'news', name: 'Daily News', tvgId: 'news.tv', url: `${origin.url}${path}` }] } }).expect(201);
    const providerA = (await mock('Provider A', '/a/index.m3u8')).body as ProviderDto;
    await waitFor(async () => (await channel_(channelId)).feeds.length === 1);
    const providerB = (await mock('Provider B', '/b/index.m3u8')).body as ProviderDto;
    const detail = await waitFor(async () => {
      const current = await channel_(channelId);
      return current.feeds.length === 2 ? current : null;
    });
    feedA = detail.feeds.find((feed) => feed.providerId === providerA.id)!.id;
    feedB = detail.feeds.find((feed) => feed.providerId === providerB.id)!.id;
    await request(admin).post(`/admin/v1/channels/${channelId}/grants`).set(ops()).send({ territory: 'GE', deviceClasses: ['web'], businessModels: ['subscription'], startAt: new Date(Date.now() - 60_000).toISOString(), contractRef: 'LIC-7' }).expect(201);

    await until(async () => (await status(feedA)) === 'HEALTHY' && (await status(feedB)) === 'HEALTHY');
    const row = (await feeds()).find((feed) => feed.feedId === feedA)!;
    expect(row.regions).toMatchObject([{ region: 'eu-central', state: 'HEALTHY' }]);
    expect(row.missingRegions).toEqual(['us-east']);
    const probes = (await request(admin).get(`/admin/v1/monitoring/feeds/${feedA}/probes`).set(ops()).expect(200)).body as ProbeResultDto[];
    expect(probes.map((p) => p.kind)).toEqual(expect.arrayContaining(['manifest', 'segment']));
    expect(probes.find((p) => p.kind === 'manifest')).toMatchObject({ outcome: 'ok', httpStatus: 200 });

    const state = await failover();
    expect(state).toMatchObject({ activeFeedId: feedA, mode: 'auto' });
    expect(state.events.at(-1)).toMatchObject({ reason: 'initial', toFeedId: feedA, actorEmail: null });
    expect(feedOf((await plan()).candidates[0]?.telemetry)).toBe(feedA);
  });

  it('a claim leases exactly one due probe (no multi-row lease under SKIP LOCKED)', async () => {
    await t.container.jobs.stop();
    const repository = new PgHealthRepository(t.db);
    const past = new Date(clock.now().getTime() - 60_000);
    await t.db.updateTable('feed_probe_state').set({ next_probe_at: past, lease_owner: null, lease_until: null }).execute();
    const claimed = await repository.claimDueProbe('eu-central', clock.now(), 'test-owner', new Date(clock.now().getTime() + 60_000), 10);
    const leased = await t.db.selectFrom('feed_probe_state').select('feed_id').where('lease_owner', '=', 'test-owner').execute();
    expect(leased.map((row) => row.feed_id)).toEqual([claimed!.feedId]);
    await t.db.updateTable('feed_probe_state').set({ lease_owner: null, lease_until: null }).execute();
    t.container.jobs.start();
  });

  const channel_ = async (id: string) => (await request(admin).get(`/admin/v1/channels/${id}`).set(ops()).expect(200)).body as MasterChannelDetailDto;

  it('fails over from a broken primary to the backup, journals it, opens an incident and alerts (Gate)', async () => {
    feedState.a.broken = true;
    await until(async () => (await status(feedA)) === 'UNHEALTHY');
    const state = await failover();
    expect(state.activeFeedId).toBe(feedB);
    expect(state.events[0]).toMatchObject({ reason: 'unhealthy', fromFeedId: feedA, toFeedId: feedB, actorEmail: null });
    const candidates = (await plan()).candidates;
    expect(feedOf(candidates[0]?.telemetry)).toBe(feedB);
    expect(feedOf(candidates.at(-1)?.telemetry)).toBe(feedA); // still offered, last

    const incidents = (await request(admin).get('/admin/v1/monitoring/incidents?status=live').set(ops()).expect(200)).body as IncidentPageDto;
    expect(incidents.items).toMatchObject([{ kind: 'feed_unhealthy', severity: 'warning', status: 'open', targetId: feedA }]);
    const hook = await waitFor(async () => {
      t.container.jobs.kick('outbox');
      return hooks.find((entry) => entry.delivery === `${incidents.items[0]!.id}:opened`);
    });
    expect(hook.signature).toBe(`sha256=${createHmac('sha256', WEBHOOK_SECRET).update(hook.body).digest('hex')}`);
    expect(JSON.parse(hook.body)).toMatchObject({ event: 'opened', incident: { kind: 'feed_unhealthy', target: { type: 'feed', id: feedA } } });
    expect(hook.body).not.toContain(origin.url);
  });

  it('fails back only after the primary proved healthy and the cooldown passed; incidents resolve', async () => {
    feedState.a.broken = false;
    await until(async () => (await status(feedA)) === 'HEALTHY');
    expect((await failover()).activeFeedId).toBe(feedB); // within the cooldown
    await until(async () => (await failover()).activeFeedId === feedA, 30, 'failover-reconcile');
    expect((await failover()).events[0]).toMatchObject({ reason: 'failback', fromFeedId: feedB, toFeedId: feedA });
    const incidents = (await request(admin).get('/admin/v1/monitoring/incidents').set(ops()).expect(200)).body as IncidentPageDto;
    expect(incidents.items.find((i) => i.targetId === feedA)).toMatchObject({ status: 'resolved' });
  });

  it('an operator pin overrides automatic failover until released (audited and journaled) (Gate)', async () => {
    await request(admin).post(`/admin/v1/monitoring/channels/${channelId}/failover/pin`).set(ops()).send({ feedId: newEntityId() }).expect(400);
    const pinned = (await request(admin).post(`/admin/v1/monitoring/channels/${channelId}/failover/pin`).set(ops()).send({ feedId: feedB, note: 'provider A maintenance tonight' }).expect(200)).body as ChannelFailoverDto;
    expect(pinned).toMatchObject({ activeFeedId: feedB, mode: 'pinned', pin: { feedId: feedB, note: 'provider A maintenance tonight' } });
    expect(pinned.events[0]).toMatchObject({ reason: 'pinned', fromFeedId: feedA, toFeedId: feedB, actorEmail: 'noc@ops.example' });
    expect(feedOf((await plan()).candidates[0]?.telemetry)).toBe(feedB);

    // Automatic decisions do not undo the pin, even with a healthy primary after the cooldown.
    tick(120, 'failover-reconcile');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await failover()).activeFeedId).toBe(feedB);

    const released = (await request(admin).delete(`/admin/v1/monitoring/channels/${channelId}/failover/pin`).set(ops()).expect(200)).body as ChannelFailoverDto;
    expect(released.mode).toBe('auto');
    expect(released.events[0]).toMatchObject({ reason: 'unpinned', actorEmail: 'noc@ops.example' });
    await request(admin).delete(`/admin/v1/monitoring/channels/${channelId}/failover/pin`).set(ops()).expect(409);
    await until(async () => (await failover()).activeFeedId === feedA, 30, 'failover-reconcile');

    const audit = (await request(admin).get('/admin/v1/audit?targetType=channel').set(ops()).expect(200)).body as AuditPageDto;
    expect(audit.items.map((entry) => entry.action)).toEqual(expect.arrayContaining(['failover.pinned', 'failover.unpinned']));
  });

  it('a frozen live playlist is a failure even though it answers 200', async () => {
    feedState.a.frozen = true;
    await until(async () => (await status(feedA)) === 'UNHEALTHY', 16);
    const probes = (await request(admin).get(`/admin/v1/monitoring/feeds/${feedA}/probes?limit=10`).set(ops()).expect(200)).body as ProbeResultDto[];
    expect(probes.some((p) => p.outcome === 'stalled' && /has not moved/.test(p.error ?? ''))).toBe(true);
    expect((await failover()).activeFeedId).toBe(feedB);
    feedState.a.frozen = false;
    await until(async () => (await status(feedA)) === 'HEALTHY');
  });

  it('maintenance takes a feed out of rotation; both feeds down = channel down (critical)', async () => {
    const maintained = await request(admin).post(`/admin/v1/monitoring/feeds/${feedB}/maintenance`).set(ops()).send({ on: true, note: 'planned' }).expect(200);
    expect(maintained.body).toMatchObject({ status: 'MAINTENANCE', maintenance: true });
    await request(admin).post(`/admin/v1/monitoring/channels/${channelId}/failover/pin`).set(ops()).send({ feedId: feedB }).expect(409);
    const candidates = (await plan()).candidates;
    expect(candidates.every((c) => feedOf(c.telemetry) === feedA)).toBe(true);
    await request(admin).post(`/admin/v1/monitoring/feeds/${feedB}/maintenance`).set(ops()).send({ on: false }).expect(200);

    feedState.a.broken = true;
    feedState.b.broken = true;
    await until(async () => (await status(feedA)) === 'UNHEALTHY' && (await status(feedB)) === 'UNHEALTHY');
    const live = (await request(admin).get('/admin/v1/monitoring/incidents?status=live').set(ops()).expect(200)).body as IncidentPageDto;
    const down = live.items.find((i) => i.kind === 'channel_down')!;
    expect(down).toMatchObject({ severity: 'critical', targetId: channelId });
    const acked = await request(admin).post(`/admin/v1/monitoring/incidents/${down.id}/acknowledge`).set(ops()).expect(200);
    expect(acked.body.status).toBe('acknowledged');
    await request(admin).post(`/admin/v1/monitoring/incidents/${down.id}/acknowledge`).set(ops()).expect(409);
    // The player still gets every feed (better a retry than nothing).
    expect((await plan()).candidates.length).toBeGreaterThanOrEqual(2);

    feedState.a.broken = false;
    feedState.b.broken = false;
    await until(async () => (await status(feedA)) === 'HEALTHY' && (await status(feedB)) === 'HEALTHY');
    const after = (await request(admin).get('/admin/v1/monitoring/incidents').set(ops()).expect(200)).body as IncidentPageDto;
    expect(after.items.find((i) => i.id === down.id)?.status).toBe('resolved');
  });

  it('viewer failure reports re-probe the feed (but never switch it by themselves)', async () => {
    const reported = feedOf((await plan()).candidates[0]!.telemetry);
    const errorOn = async (current: PlaybackPlanDto, token = current.candidates[0]!.telemetry!) =>
      request(t.app).post('/api/v1/playback/events').set(as()).send({ sessionId: current.sessionId, type: 'error', error: { kind: 'network', message: 'boom' }, telemetry: token }).expect(204);
    // Five viewings fail on the same feed …
    const viewings: PlaybackPlanDto[] = [];
    for (let i = 0; i < 5; i++) viewings.push(await plan());
    for (const viewing of viewings) await errorOn(viewing);
    // … replays of one viewing's token count at most 3 times; a token of another viewing or a forged one not at all.
    for (let i = 0; i < 5; i++) await errorOn(viewings[0]!);
    await request(t.app).post('/api/v1/playback/events').set(as()).send({ sessionId: viewings[1]!.sessionId, type: 'error', telemetry: viewings[2]!.candidates[0]!.telemetry }).expect(204);
    await request(t.app).post('/api/v1/playback/events').set(as()).send({ sessionId: viewings[1]!.sessionId, type: 'error', telemetry: 'f00.forged.token' }).expect(204);
    await request(t.app).post('/api/v1/playback/events').set(as()).send({ sessionId: viewings[1]!.sessionId, type: 'start', startupMs: 900, telemetry: viewings[1]!.candidates[0]!.telemetry }).expect(204);

    const rows = await t.db.selectFrom('playback_telemetry').selectAll().where('subject_id', '=', reported).execute();
    expect(rows.reduce((sum, row) => sum + row.errors, 0)).toBe(7);
    expect(rows.reduce((sum, row) => sum + row.starts, 0)).toBe(1);
    const state = await t.db.selectFrom('feed_probe_state').select('next_probe_at').where('feed_id', '=', reported).executeTakeFirstOrThrow();
    expect(state.next_probe_at.getTime()).toBeLessThanOrEqual(clock.now().getTime());
    expect((await failover()).activeFeedId).toBe(reported);
  });

  it('an incident of a feed that leaves the catalog is resolved', async () => {
    feedState.a.broken = true;
    await until(async () => (await status(feedA)) === 'UNHEALTHY');
    const open = (await request(admin).get('/admin/v1/monitoring/incidents?status=live').set(ops()).expect(200)).body as IncidentPageDto;
    const incident = open.items.find((i) => i.targetId === feedA)!;
    await request(admin).patch(`/admin/v1/feeds/${feedA}`).set(ops()).send({ status: 'disabled' }).expect(200);
    await until(async () => ((await request(admin).get('/admin/v1/monitoring/incidents').set(ops())).body as IncidentPageDto).items.find((i) => i.id === incident.id)?.status === 'resolved', 61, 'failover-reconcile');
    feedState.a.broken = false;
    await request(admin).patch(`/admin/v1/feeds/${feedA}`).set(ops()).send({ status: 'active' }).expect(200);
    await until(async () => (await status(feedA)) === 'HEALTHY');
  });

  it('BYO sources get Online / Offline from light endpoint checks', async () => {
    const source = (await request(t.app).post('/api/v1/sources').set(as()).send({ type: 'm3u_url', url: `${origin.url}/list.m3u` }).expect(202)).body as SourceDto;
    const read = async () => (await request(t.app).get(`/api/v1/sources/${source.id}`).set(as()).expect(200)).body as SourceDto;
    await waitFor(async () => (await read()).revision > 0);
    const online = await until(async () => {
      const current = await read();
      return current.health.state === 'online' ? current : null;
    }, 400, 'source-health');
    expect(online.health).toMatchObject({ state: 'online', plays: 0, failedPlays: 0 });
    expect(online.health.latencyMs).not.toBeNull();
    listBroken = true;
    const offline = await until(async () => {
      const current = await read();
      return current.health.state === 'offline' ? current : null;
    }, 1900, 'source-health');
    expect(offline.health.message).toMatch(/HTTP 503/);
    listBroken = false;
  });

  it('exposes Prometheus metrics behind a token', async () => {
    await request(t.app).get('/metrics').expect(401);
    await request(t.app).get('/metrics').set('Authorization', 'Bearer wrong-token-wrong-token').expect(401);
    const metrics = (await request(t.app).get('/metrics').set('Authorization', 'Bearer metrics-token-for-tests').expect(200)).text;
    expect(metrics).toMatch(/ziptv_failovers_total\{[^}]*reason="unhealthy"[^}]*\} [1-9]/);
    expect(metrics).toMatch(/ziptv_feeds\{[^}]*state="HEALTHY"[^}]*\} 2/);
    expect(metrics).toMatch(/ziptv_probe_duration_seconds_count\{[^}]*region="eu-central",outcome="ok"/);
    expect(metrics).toMatch(/ziptv_http_request_duration_seconds_count\{[^}]*method="POST",route="\/api\/v1\/playback\/",status="200"/);
    expect(metrics).not.toContain(origin.url);
  });
});

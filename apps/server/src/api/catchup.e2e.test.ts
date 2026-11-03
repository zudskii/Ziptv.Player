import type { AuthSessionDto, DeviceDto, MasterChannelDetailDto, OperatorChannelListDto, OperatorScheduleDto, PlaybackSessionDto, ProviderDto, RightsGrantDto } from '@ziptv/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newEntityId } from '../domain/shared/ids.js';
import { createLogger } from '../infrastructure/logger.js';
import { staffSession, type StaffSession } from '../test/console.js';
import { startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';
import { createAdminApp } from './admin/admin-app.js';

const TS = Buffer.alloc(188 * 3, 0xff);
[0, 188, 376].forEach((offset) => (TS[offset] = 0x47));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Catch-up of licensed (operator) channels, Phase 10.3: archive viewings are playback sessions
 * like live ones (device, entitlement, stream slot), and need catch-up rights that cover the
 * viewer now *and* covered the broadcast, inside both the licensed window and the provider's
 * archive. The archive address is built server-side and delivered through the proxy only.
 */
describe.skipIf(!TEST_DATABASE_URL)('Operator catch-up', () => {
  let t: TestApp;
  let admin: Express;
  let origin: FakeOrigin;
  let content: StaffSession;
  const upstream: string[] = [];
  let archived: MasterChannelDetailDto; // archive rights 2 days
  let liveOnly: MasterChannelDetailDto; // no catch-up rights
  let recent: MasterChannelDetailDto; // licensed only since yesterday, 7 days of catch-up
  let archivedGrant: RightsGrantDto;
  let viewer: { token: string; device: DeviceDto };

  beforeAll(async () => {
    origin = await startOrigin((req, res) => {
      upstream.push(req.url ?? '');
      if ((req.url ?? '').split('?')[0]?.endsWith('.ts')) return void res.writeHead(200, { 'content-type': 'video/mp2t' }).end(TS);
      res.writeHead(404).end();
    });
    t = await startTestApp({ JOBS_ENABLED: 'true', CONSOLE_FOUR_EYES: 'false', PROBES_ENABLED: 'false', OPERATOR_DEFAULT_COUNTRY: 'GE' });
    t.container.jobs.start();
    admin = createAdminApp({ config: t.config, logger: createLogger({ log: { level: 'silent' }, env: 'test' }), container: t.container });
    content = await staffSession(t, admin, 'content@ops.example', 'CONTENT_MANAGER');

    const channel = async (name: string) => (await request(admin).post('/admin/v1/channels').set(content.headers).send({ name, originCountry: 'GE', globalUid: `${name}.tv` }).expect(201)).body as MasterChannelDetailDto;
    archived = await channel('archived');
    liveOnly = await channel('liveonly');
    recent = await channel('recent');
    const provider = (
      await request(admin)
        .post('/admin/v1/providers')
        .set(content.headers)
        .send({
          name: 'Archive Licensor',
          type: 'mock',
          config: {
            channels: [
              { id: 'a', name: 'archived', tvgId: 'archived.tv', url: `${origin.url}/live/a.ts`, kind: 'mpegts', catchup: { mode: 'shift', days: 7 } },
              { id: 'l', name: 'liveonly', tvgId: 'liveonly.tv', url: `${origin.url}/live/l.ts`, kind: 'mpegts', catchup: { mode: 'shift', days: 7 } },
              { id: 'r', name: 'recent', tvgId: 'recent.tv', url: `${origin.url}/live/r.ts`, kind: 'mpegts', catchup: { mode: 'default', days: 7, template: '/archive/r-{utc}-{duration}.ts' } },
            ],
          },
        })
        .expect(201)
    ).body as ProviderDto;
    await waitFor(async () => {
      const current = ((await request(admin).get('/admin/v1/providers').set(content.headers)).body as ProviderDto[]).find((p) => p.id === provider.id)!;
      return current.sync.lastSuccessAt ? current : null;
    });
    const grant = (channelId: string, body: Record<string, unknown>) =>
      request(admin)
        .post(`/admin/v1/channels/${channelId}/grants`)
        .set(content.headers)
        .send({ territory: '*', deviceClasses: ['web'], businessModels: ['fast'], startAt: new Date(Date.now() - 10 * DAY).toISOString(), contractRef: 'ARC-1', ...body })
        .expect(201);
    archivedGrant = (await grant(archived.id, { catchupDays: 2 })).body as RightsGrantDto;
    await grant(liveOnly.id, {});
    await grant(recent.id, { catchupDays: 7, startAt: new Date(Date.now() - DAY).toISOString() });

    const session = (await request(t.app).post('/api/v1/auth/register').send({ email: 'viewer@example.com', password: 'correct-horse-battery-9' }).expect(201)).body as AuthSessionDto;
    const device = (await request(t.app).post('/api/v1/devices').set({ Authorization: `Bearer ${session.token}` }).send({ key: newEntityId() + newEntityId(), name: 'Laptop', platform: 'web' }).expect(201)).body as DeviceDto;
    viewer = { token: session.token, device };
  });
  afterAll(async () => {
    await t?.close();
    await origin?.close();
  });

  const auth = () => ({ Authorization: `Bearer ${viewer.token}` });
  const hourAgo = (hours: number) => new Date(Math.floor(Date.now() / HOUR) * HOUR - hours * HOUR);
  const archiveOf = (start: Date, minutes = 60) => ({ start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString() });
  const play = (channelId: string, archive?: { start: string; end: string }) =>
    request(t.app)
      .post('/api/v1/operator/playback/sessions')
      .set(auth())
      .send({ channelId, deviceId: viewer.device.id, secureContext: false, ...(archive ? { archive } : {}) });
  const stop = (id: string) => request(t.app).delete(`/api/v1/operator/playback/sessions/${id}`).set(auth()).expect(204);

  it('lists each channel with the archive this viewer may replay (licensed × provider)', async () => {
    const list = (await request(t.app).get('/api/v1/operator/channels').set(auth()).expect(200)).body as OperatorChannelListDto;
    const days = Object.fromEntries(list.channels.map((channel) => [channel.name, channel.catchupDays]));
    expect(days).toEqual({ archived: 2, liveonly: 0, recent: 7 });
    const schedule = (await request(t.app).get(`/api/v1/operator/channels/${archived.id}/schedule`).set(auth()).expect(200)).body as OperatorScheduleDto;
    expect(schedule).toMatchObject({ channelId: archived.id, catchupDays: 2, programmes: [] });
  });

  it('replays a programme through a playback session; the archive URL is built server-side and proxied', async () => {
    const start = hourAgo(3);
    const session = (await play(archived.id, archiveOf(start)).expect(201)).body as PlaybackSessionDto;
    expect(session.plan.content).toMatchObject({ mode: 'catchup', durationSecs: 3600, ref: { type: 'operator', channelId: archived.id, start: start.toISOString() } });
    expect(session.plan.candidates.every((candidate) => candidate.via === 'proxy')).toBe(true);
    expect(JSON.stringify(session)).not.toContain(origin.url);
    await request(t.app).get(session.plan.candidates[0]!.url).expect(200);
    const fetched = new URL(upstream.at(-1)!, 'http://x');
    expect(fetched.pathname).toBe('/live/a.ts');
    expect(fetched.searchParams.get('utc')).toBe(String(start.getTime() / 1000));
    await request(t.app).post(`/api/v1/operator/playback/sessions/${session.playbackSessionId}/heartbeat`).set(auth()).send({}).expect(200);
    await stop(session.playbackSessionId);
  });

  it('refuses programmes outside the licensed window, before the licence, or without catch-up rights', async () => {
    // Provider keeps 7 days, but the licence allows 2.
    expect((await play(archived.id, archiveOf(hourAgo(3 * 24))).expect(403)).body.error.details).toMatchObject({ reason: 'catchup_not_licensed' });
    // Live rights only.
    expect((await play(liveOnly.id, archiveOf(hourAgo(3))).expect(403)).body.error.details).toMatchObject({ reason: 'catchup_not_licensed' });
    const live = (await play(liveOnly.id).expect(201)).body as PlaybackSessionDto;
    await stop(live.playbackSessionId);
    // 7 days of catch-up, but the licence began yesterday: older broadcasts are not ours to replay.
    expect((await play(recent.id, archiveOf(hourAgo(30))).expect(403)).body.error.details).toMatchObject({ reason: 'catchup_not_licensed' });
    const replay = (await play(recent.id, archiveOf(hourAgo(5), 30)).expect(201)).body as PlaybackSessionDto;
    await request(t.app).get(replay.plan.candidates[0]!.url).expect(200);
    expect(upstream.at(-1)).toBe(`/archive/r-${hourAgo(5).getTime() / 1000}-1800.ts`);
    await stop(replay.playbackSessionId);
    // Not over yet.
    const onAir = new Date(Date.now() - 10 * 60_000);
    expect((await play(archived.id, archiveOf(onAir)).expect(422)).body.error.details).toMatchObject({ reason: 'catchup_unavailable', problem: 'not_ended' });
  });

  it('a revoked licence ends a running catch-up viewing at once', async () => {
    const session = (await play(archived.id, archiveOf(hourAgo(4))).expect(201)).body as PlaybackSessionDto;
    await request(t.app).get(session.plan.candidates[0]!.url).expect(200);
    await request(admin).post(`/admin/v1/grants/${archivedGrant.id}/revoke`).set(content.headers).expect(200);
    await waitFor(async () => ((await request(t.app).get(session.plan.candidates[0]!.url)).status === 403 ? true : null));
    await request(t.app).post(`/api/v1/operator/playback/sessions/${session.playbackSessionId}/heartbeat`).set(auth()).send({}).expect(404);
  });
});

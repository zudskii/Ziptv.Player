import type {
  AdminLoginResponse,
  AdminSessionDto,
  AuditPageDto,
  AuditVerificationDto,
  CategoryDto,
  HistoryPageDto,
  LineupDetailDto,
  ListStateDto,
  MasterChannelDetailDto,
  OperatorChannelListDto,
  PlaybackPlanDto,
  ProfileDto,
  ProviderDto,
  ProviderStreamPageDto,
  RightsGrantDto,
  SessionDto,
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
import { startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';
import { createAdminApp } from './admin/admin-app.js';

/**
 * Operator master catalog end to end (Phase 6, ZP-ENT-03): two licensed providers are ingested,
 * the same channel from both is recognised by its curated aliases (one master channel, two
 * feeds), the review queue creates/matches the rest, rights decide visibility and playback per
 * market/device/time, delivery is proxied only, and every console change is audited.
 */

const TS = Buffer.alloc(188 * 3, 0xff);
[0, 188, 376].forEach((offset) => (TS[offset] = 0x47));
const PASSWORD = 'initial-password-123';

describe.skipIf(!TEST_DATABASE_URL)('Operator master catalog', () => {
  let t: TestApp;
  let admin: Express;
  let origin: FakeOrigin;
  let staff = '';
  let viewer = '';
  let offsetMs = 0;
  const clock: Clock = { now: () => new Date(Date.now() + offsetMs) };
  const ops = () => ({ Authorization: `Bearer ${staff}` });
  const as = (headers: Record<string, string> = {}) => ({ Authorization: `Bearer ${viewer}`, ...headers });

  let category: { news: CategoryDto; adult: CategoryDto };
  let news: MasterChannelDetailDto;
  let mock: ProviderDto;
  let m3u: ProviderDto;

  beforeAll(async () => {
    origin = await startOrigin((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/provider.m3u') {
        const base = `http://${req.headers.host}`;
        return void res
          .writeHead(200, { 'content-type': 'audio/x-mpegurl' })
          .end(['#EXTM3U', '#EXTINF:-1 tvg-id="news.tv" group-title="News",Daily News', `${base}/live/news-b.ts`, '#EXTINF:-1 group-title="Sport",Arena Sport', `${base}/live/sport-b.ts`].join('\n'));
      }
      if (path?.endsWith('.ts')) return void res.writeHead(200, { 'content-type': 'video/mp2t' }).end(TS);
      res.writeHead(404).end();
    });
    t = await startTestApp({ JOBS_ENABLED: 'true', OPERATOR_ACCESS: 'rights', OPERATOR_COUNTRY_HEADER: 'cf-ipcountry', OPERATOR_DEFAULT_COUNTRY: 'GE' }, { clock });
    t.container.jobs.start();
    admin = createAdminApp({ config: t.config, logger: createLogger({ log: { level: 'silent' }, env: 'test' }), container: t.container });

    const hash = await new ScryptPasswordHasher({ N: 2 ** 10, r: 8, p: 1 }, 4).hash(PASSWORD);
    await new PgAdminUnitOfWork(t.db).run((tx) => tx.staff.create({ id: newEntityId(), email: 'content@ops.example', name: 'Content', role: 'CONTENT_MANAGER', passwordHash: hash, now: new Date() }));
    const login = (await request(admin).post('/admin/v1/auth/login').send({ email: 'content@ops.example', password: PASSWORD }).expect(200)).body as AdminLoginResponse;
    if (login.step !== 'enroll') throw new Error('expected enrolment');
    staff = ((await request(admin).post('/admin/v1/auth/mfa').send({ challenge: login.challenge, code: totpCode(login.secret, totpStep(Date.now())) }).expect(200)).body as AdminSessionDto).token;
    await request(admin).post('/admin/v1/auth/password').set(ops()).send({ currentPassword: PASSWORD, newPassword: 'content-passphrase-ok' }).expect(204);

    viewer = ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token;
  });
  afterAll(async () => {
    await t?.close();
    await origin?.close();
  });

  const provider = async (id: string) => ((await request(admin).get('/admin/v1/providers').set(ops()).expect(200)).body as ProviderDto[]).find((p) => p.id === id)!;
  const synced = (id: string, after = 0) =>
    waitFor(async () => {
      const current = await provider(id);
      return current.sync.status === 'idle' && current.sync.lastSuccessAt && Date.parse(current.sync.lastSuccessAt) > after ? current : null;
    });
  const channel = async (id: string) => (await request(admin).get(`/admin/v1/channels/${id}`).set(ops()).expect(200)).body as MasterChannelDetailDto;
  const list = async (headers: Record<string, string> = {}, query = '') => (await request(t.app).get(`/api/v1/operator/channels${query}`).set(as(headers)).expect(200)).body as OperatorChannelListDto;
  const play = (channelId: string, headers: Record<string, string> = {}, device?: string) =>
    request(t.app)
      .post('/api/v1/playback')
      .set(as(headers))
      .send({ content: { type: 'operator', channelId }, secureContext: false, ...(device ? { device } : {}) });
  const grant = async (channelId: string, body: Record<string, unknown>) =>
    (await request(admin).post(`/admin/v1/channels/${channelId}/grants`).set(ops()).send({ deviceClasses: ['web'], businessModels: ['subscription'], startAt: new Date(Date.now() - 60_000).toISOString(), contractRef: 'LIC-2026-001', ...body }).expect(201)).body as RightsGrantDto;

  it('curates categories and a master channel; its global id and name become dedup aliases', async () => {
    const created = await Promise.all([
      request(admin).post('/admin/v1/categories').set(ops()).send({ name: 'News' }).expect(201),
      request(admin).post('/admin/v1/categories').set(ops()).send({ name: 'Adult' }).expect(201),
    ]);
    category = { news: created[0].body as CategoryDto, adult: created[1].body as CategoryDto };
    expect(category.adult.slug).toBe('adult');
    await request(admin).post('/admin/v1/categories').set(ops()).send({ name: 'News' }).expect(409);

    news = (await request(admin).post('/admin/v1/channels').set(ops()).send({ name: 'Daily News', originCountry: 'GE', languages: ['ka', 'en'], categoryId: category.news.id, globalUid: 'news.tv' }).expect(201)).body as MasterChannelDetailDto;
    expect(news).toMatchObject({ slug: 'daily-news', status: 'active', feeds: [], grants: [] });
    expect(news.aliases).toEqual(expect.arrayContaining([{ kind: 'tvg_id', key: 'news.tv' }, expect.objectContaining({ kind: 'name' })]));
    expect((await request(admin).post('/admin/v1/channels').set(ops()).send({ name: 'Bad', originCountry: 'Georgia' }).expect(400)).body.error.code).toBe('VALIDATION_ERROR');
  });

  it('ingests two providers: the same channel from both becomes one master channel with two feeds (Gate)', async () => {
    mock = (
      await request(admin)
        .post('/admin/v1/providers')
        .set(ops())
        .send({
          name: 'Provider A',
          type: 'mock',
          config: {
            channels: [
              { id: 'news-a', name: 'Daily News HD', tvgId: 'news.tv', url: `${origin.url}/live/news-a.ts` },
              { id: 'sport-a', name: 'Arena Sport', url: `${origin.url}/live/sport-a.ts` },
              { id: 'club', name: 'Night Club', url: `${origin.url}/live/club.ts` },
            ],
          },
        })
        .expect(201)
    ).body as ProviderDto;
    m3u = (await request(admin).post('/admin/v1/providers').set(ops()).send({ name: 'Provider B', type: 'm3u', credential: { connection: { url: `${origin.url}/provider.m3u` } } }).expect(201)).body as ProviderDto;
    // The credential is stored encrypted and never shown again.
    expect(m3u.credential).toMatchObject({ source: 'stored' });
    expect(JSON.stringify(await request(admin).get('/admin/v1/providers').set(ops()))).not.toContain('provider.m3u');
    expect((await t.db.selectFrom('provider_credentials').select('secret_ref').where('provider_id', '=', m3u.id).executeTakeFirstOrThrow()).secret_ref).toMatch(/^enc:/);
    await request(admin).post('/admin/v1/providers').set(ops()).send({ name: 'No creds', type: 'xtream' }).expect(400);

    await Promise.all([synced(mock.id), synced(m3u.id)]);
    news = await channel(news.id);
    expect(news.feeds).toHaveLength(2);
    expect(news.feeds.map((f) => f.providerName).sort()).toEqual(['Provider A', 'Provider B']);
    expect(news.feeds.every((f) => f.playable)).toBe(true);
    expect(new Set(news.feeds.map((f) => f.priority)).size).toBe(2);
    expect((await provider(mock.id)).stats).toMatchObject({ streams: 3, matched: 1, pending: 2 });
  });

  it('reviews the queue: create a channel from a stream; the next sync of the other provider matches it automatically', async () => {
    const queue = (await request(admin).get(`/admin/v1/streams?providerId=${mock.id}`).set(ops()).expect(200)).body as ProviderStreamPageDto;
    expect(queue.items.map((s) => s.name).sort()).toEqual(['Arena Sport', 'Night Club']);
    const sport = queue.items.find((s) => s.name === 'Arena Sport')!;
    const club = queue.items.find((s) => s.name === 'Night Club')!;
    expect(JSON.stringify(queue)).not.toContain(origin.url);

    await request(admin).post(`/admin/v1/streams/${sport.id}/review`).set(ops()).send({ action: 'create', originCountry: 'GE' }).expect(200);
    await request(admin).post(`/admin/v1/streams/${club.id}/review`).set(ops()).send({ action: 'create', categoryId: category.adult.id }).expect(200);
    await request(admin).post(`/admin/v1/streams/${sport.id}/review`).set(ops()).send({ action: 'match', channelId: newEntityId() }).expect(404);

    const before = Date.parse((await provider(m3u.id)).sync.lastSuccessAt!);
    await request(admin).post(`/admin/v1/providers/${m3u.id}/sync`).set(ops()).expect(202);
    await synced(m3u.id, before);
    const sportChannel = (await request(admin).get('/admin/v1/channels?q=arena').set(ops()).expect(200)).body as { items: { id: string; name: string }[] };
    expect(sportChannel.items.map((c) => c.name)).toEqual(['Arena Sport']);
    const detail = await channel(sportChannel.items[0]!.id);
    expect(detail.feeds.map((f) => f.providerName).sort()).toEqual(['Provider A', 'Provider B']);
    expect(((await request(admin).get(`/admin/v1/streams?providerId=${m3u.id}`).set(ops()).expect(200)).body as ProviderStreamPageDto).total).toBe(0);
  });

  it('shows only channels with rights for the viewer’s market and device; no rights = not visible and 403 (Gate)', async () => {
    const sport = ((await request(admin).get('/admin/v1/channels?q=arena').set(ops())).body as { items: { id: string }[] }).items[0]!;
    // No grants at all: nothing is visible.
    expect((await list()).channels).toEqual([]);
    expect((await play(news.id).expect(403)).body.error).toMatchObject({ code: 'NOT_ENTITLED', details: { reason: 'not_licensed' } });

    await grant(news.id, { territory: 'GE' });
    const georgia = await list();
    expect(georgia).toMatchObject({ country: 'GE', device: 'web' });
    expect(georgia.channels.map((c) => c.name)).toEqual(['Daily News']);
    expect(georgia.channels[0]).toMatchObject({ category: 'News', languages: ['ka', 'en'], favorite: false });
    expect(georgia.channels.map((c) => c.id)).not.toContain(sport.id);
    expect((await play(sport.id).expect(403)).body.error.details).toEqual({ reason: 'not_licensed' });

    // Another market (edge header) and another device class.
    expect((await list({ 'cf-ipcountry': 'US' })).channels).toEqual([]);
    expect((await play(news.id, { 'cf-ipcountry': 'US' }).expect(403)).body.error.details).toEqual({ reason: 'territory' });
    expect((await list({}, '?device=tv')).channels).toEqual([]);
    expect((await play(news.id, {}, 'tv').expect(403)).body.error.details).toEqual({ reason: 'device' });
    // A client cannot pick its market: there is no country parameter.
    await request(t.app).get('/api/v1/operator/channels?country=US').set(as()).expect(400);
  });

  it('plays through the proxy only, with every licensed feed as a candidate in priority order', async () => {
    const plan = (await play(news.id).expect(200)).body as PlaybackPlanDto;
    expect(plan.content).toMatchObject({ title: 'Daily News', subtitle: 'News', mode: 'live', ref: { type: 'operator', channelId: news.id } });
    expect(plan.candidates.length).toBeGreaterThanOrEqual(2);
    expect(plan.candidates.every((c) => c.via === 'proxy')).toBe(true);
    expect(JSON.stringify(plan)).not.toContain('127.0.0.1');
    const body = (await request(t.app).get(plan.candidates[0]!.url.replace(/^\/api\/v1/, '/api/v1')).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    })).body as Buffer;
    expect(body.subarray(0, 1)[0]).toBe(0x47);

    // Disabling the primary feed leaves the backup.
    const primary = [...news.feeds].sort((a, b) => a.priority - b.priority)[0]!;
    await request(admin).patch(`/admin/v1/feeds/${primary.id}`).set(ops()).send({ status: 'disabled' }).expect(200);
    const fewer = (await play(news.id).expect(200)).body as PlaybackPlanDto;
    expect(fewer.candidates.length).toBeLessThan(plan.candidates.length);
    await request(admin).patch(`/admin/v1/feeds/${primary.id}`).set(ops()).send({ status: 'active' }).expect(200);
  });

  it('keeps favourites and history by master channel; kids profiles never see adult channels', async () => {
    const club = ((await request(admin).get('/admin/v1/channels?q=night').set(ops())).body as { items: { id: string }[] }).items[0]!;
    await grant(club.id, { territory: '*' });
    expect((await list()).channels.map((c) => c.name)).toEqual(['Daily News', 'Night Club']);
    const kids = (await request(t.app).post('/api/v1/profiles').set(as()).send({ name: 'Kids', kind: 'kids' }).expect(201)).body as ProfileDto;
    expect((await list({ 'X-Profile-Id': kids.id })).channels.map((c) => c.name)).toEqual(['Daily News']);
    await play(club.id, { 'X-Profile-Id': kids.id }).expect(404);

    await request(t.app).put(`/api/v1/operator/favorites/${news.id}`).set(as()).expect(204);
    await request(t.app).put(`/api/v1/operator/favorites/${newEntityId()}`).set(as()).expect(404);
    expect((await list()).channels.find((c) => c.id === news.id)?.favorite).toBe(true);
    const myList = (await request(t.app).get('/api/v1/me/list').set(as()).expect(200)).body as ListStateDto;
    expect(myList.items).toMatchObject([{ type: 'operator', key: news.id, title: 'Daily News', available: true }]);

    const plan = (await play(news.id).expect(200)).body as PlaybackPlanDto;
    const event = (type: string) => request(t.app).post('/api/v1/playback/events').set(as()).send({ sessionId: plan.sessionId, type }).expect(204);
    await event('start');
    offsetMs += 60_000;
    await event('heartbeat');
    offsetMs += 60_000;
    await event('stop');
    const history = (await request(t.app).get('/api/v1/me/history').set(as()).expect(200)).body as HistoryPageDto;
    expect(history.items).toMatchObject([{ id: plan.sessionId, contentType: 'operator', key: news.id, title: 'Daily News' }]);
  });

  it('imports operator favourites from channels already on My List (own sources)', async () => {
    await request(t.app).delete(`/api/v1/operator/favorites/${news.id}`).set(as()).expect(204);
    const added = (await request(t.app).post('/api/v1/sources').set(as()).send({ type: 'm3u_url', url: `${origin.url}/provider.m3u` }).expect(202)).body as { id: string };
    const own = await waitFor(async () => {
      const body = (await request(t.app).get(`/api/v1/live/${added.id}/channels`).set(as())).body as { channels?: { key: string; name: string }[] };
      return body.channels?.length ? body.channels : null;
    });
    await request(t.app).put(`/api/v1/me/list/channel/${added.id}/${own.find((c) => c.name === 'Daily News')!.key}`).set(as()).expect(200);
    expect((await request(t.app).post('/api/v1/operator/favorites/import-from-my-list').set(as()).expect(200)).body).toEqual({ added: 1 });
    expect((await request(t.app).post('/api/v1/operator/favorites/import-from-my-list').set(as()).expect(200)).body).toEqual({ added: 0 });
    expect((await list()).channels.find((c) => c.id === news.id)?.favorite).toBe(true);
  });

  it('numbers channels in a market lineup', async () => {
    const lineup = (await request(admin).post('/admin/v1/lineups').set(ops()).send({ name: 'Basic', country: 'GE' }).expect(201)).body as LineupDetailDto;
    expect(lineup.slug).toBe('ge-basic');
    const club = ((await request(admin).get('/admin/v1/channels?q=night').set(ops())).body as { items: { id: string }[] }).items[0]!;
    await request(admin)
      .patch(`/admin/v1/lineups/${lineup.id}`)
      .set(ops())
      .send({ entries: [{ channelId: news.id, number: 1 }, { channelId: club.id, number: 1 }] })
      .expect(400);
    await request(admin).patch(`/admin/v1/lineups/${lineup.id}`).set(ops()).send({ status: 'active', entries: [{ channelId: news.id, number: 1 }] }).expect(200);
    const numbered = await list({}, '?lineup=ge-basic');
    expect(numbered.lineup).toMatchObject({ slug: 'ge-basic', country: 'GE' });
    expect(numbered.channels.map((c) => [c.name, c.number])).toEqual([['Daily News', 1]]);
    expect((await list()).lineups.map((l) => l.slug)).toEqual(['ge-basic']);
    await request(t.app).get('/api/v1/operator/channels?lineup=nope').set(as()).expect(404);
  });

  it('merges a duplicate channel (feeds, rights, favourites and history follow) and revokes rights', async () => {
    const duplicate = (await request(admin).post('/admin/v1/channels').set(ops()).send({ name: 'Daily News' }).expect(201)).body as MasterChannelDetailDto;
    expect(duplicate.slug).toBe('daily-news-2');
    await grant(duplicate.id, { territory: 'US' });
    await request(admin).post(`/admin/v1/channels/${news.id}/merge`).set(ops()).send({ fromChannelId: news.id }).expect(400);
    const merged = (await request(admin).post(`/admin/v1/channels/${news.id}/merge`).set(ops()).send({ fromChannelId: duplicate.id }).expect(200)).body as MasterChannelDetailDto;
    expect(merged.grants.map((g) => g.territory).sort()).toEqual(['GE', 'US']);
    await request(admin).get(`/admin/v1/channels/${duplicate.id}`).set(ops()).expect(404);
    expect((await list({ 'cf-ipcountry': 'US' })).channels.map((c) => c.name)).toEqual(['Daily News', 'Night Club']);

    for (const item of merged.grants) await request(admin).post(`/admin/v1/grants/${item.id}/revoke`).set(ops()).expect(200);
    await request(admin).post(`/admin/v1/grants/${merged.grants[0]!.id}/revoke`).set(ops()).expect(409);
    expect((await list()).channels.map((c) => c.name)).toEqual(['Night Club']);
    expect((await play(news.id).expect(403)).body.error.code).toBe('NOT_ENTITLED');
    const myList = (await request(t.app).get('/api/v1/me/list').set(as()).expect(200)).body as ListStateDto;
    expect(myList.items.filter((i) => i.type === 'operator')).toMatchObject([{ type: 'operator', key: news.id, available: false }]);
  });

  it('a removed feed stays removed after the next sync; a matched stream cannot spawn a second channel', async () => {
    const detail = await channel(news.id);
    const feed = detail.feeds.find((f) => f.providerName === 'Provider B')!;
    await request(admin).post(`/admin/v1/streams/${feed.streamId}/review`).set(ops()).send({ action: 'create' }).expect(409);
    await request(admin).delete(`/admin/v1/feeds/${feed.id}`).set(ops()).expect(204);
    const ignored = (await request(admin).get(`/admin/v1/streams?providerId=${m3u.id}&status=ignored`).set(ops()).expect(200)).body as ProviderStreamPageDto;
    expect(ignored.items.map((s) => s.id)).toContain(feed.streamId);
    const before = Date.parse((await provider(m3u.id)).sync.lastSuccessAt!);
    await request(admin).post(`/admin/v1/providers/${m3u.id}/sync`).set(ops()).expect(202);
    await synced(m3u.id, before);
    expect((await channel(news.id)).feeds.map((f) => f.providerName)).toEqual(['Provider A']);
  });

  it('audits every change in the tamper-evident trail; viewers cannot reach the console API', async () => {
    const audit = (await request(admin).get('/admin/v1/audit?limit=200').set(ops()).expect(200)).body as AuditPageDto;
    const actions = new Set(audit.items.map((e) => e.action));
    for (const action of ['provider.created', 'provider.sync_requested', 'category.created', 'channel.created', 'stream.matched', 'feed.updated', 'feed.deleted', 'rights.granted', 'rights.revoked', 'lineup.created', 'lineup.updated', 'channel.merged']) {
      expect(actions, action).toContain(action);
    }
    expect(JSON.stringify(audit)).not.toContain('provider.m3u');
    expect(((await request(admin).get('/admin/v1/audit/verify').set(ops()).expect(200)).body as AuditVerificationDto).intact).toBe(true);
    await request(t.app).get('/admin/v1/providers').set(as()).expect(404);
  });
});

import type {
  AdminLoginResponse,
  AdminSessionDto,
  MasterChannelDetailDto,
  OperatorChannelListDto,
  PlaybackPlanDto,
  ProviderConflictsDto,
  ProviderContentDto,
  ProviderDto,
  ProviderStreamPageDto,
  ProviderSyncEventDto,
  SessionDto,
} from '@ziptv/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { totpCode, totpStep } from '../domain/admin/totp.js';
import { newEntityId } from '../domain/shared/ids.js';
import { ScryptPasswordHasher } from '../infrastructure/crypto/password-hasher.js';
import { createLogger } from '../infrastructure/logger.js';
import { PgAdminUnitOfWork } from '../infrastructure/persistence/postgres/repositories/admin.repository.js';
import { startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';
import { ReferenceVendorFeed } from '../test/reference-vendor-feed.js';
import { createAdminApp } from './admin/admin-app.js';

/**
 * Content provider foundation end to end (Phase 16): a vendor delivers a signed ZIPTV Vendor Feed
 * (channels with rights, a movie, a series, a package); the console onboards it with the vendor's
 * key; syncs are incremental; the feed's rights become grants that decide what viewers see — and a
 * quality limit in them takes the tall variants out of the stream. Refused feeds change nothing and
 * every sync is journalled.
 */

const PASSWORD = 'initial-password-123';
const MASTER = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', 'low.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080', 'high.m3u8'].join('\n');

describe.skipIf(!TEST_DATABASE_URL)('Vendor feed provider', () => {
  let t: TestApp;
  let admin: Express;
  let origin: FakeOrigin;
  let staff = '';
  let viewer = '';
  let provider: ProviderDto;
  let news: MasterChannelDetailDto;
  const vendor = new ReferenceVendorFeed('acme-media');
  const ops = () => ({ Authorization: `Bearer ${staff}` });
  const as = (country = 'GE') => ({ Authorization: `Bearer ${viewer}`, 'cf-ipcountry': country });
  const right = (patch: Record<string, unknown> = {}) => ({ territories: ['GE'], devices: ['web'], models: ['subscription'], start: new Date(Date.now() - 86_400_000).toISOString(), catchupDays: 0, ...patch });

  const current = async () => ((await request(admin).get('/admin/v1/providers').set(ops()).expect(200)).body as ProviderDto[]).find((p) => p.id === provider.id)!;
  const events = async () => (await request(admin).get(`/admin/v1/providers/${provider.id}/events`).set(ops()).expect(200)).body as ProviderSyncEventDto[];
  /** Requests a sync and waits for its journal entry. */
  const sync = async () => {
    const before = (await events()).length;
    await request(admin).post(`/admin/v1/providers/${provider.id}/sync`).set(ops()).expect(202);
    return waitFor(async () => {
      const list = await events();
      return list.length > before && (await current()).sync.status !== 'running' ? list[0]! : null;
    });
  };
  const channels = async (country = 'GE') => (await request(t.app).get('/api/v1/operator/channels').set(as(country)).expect(200)).body as OperatorChannelListDto;

  beforeAll(async () => {
    origin = await startOrigin((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/feed') return vendor.handle(req, res);
      if (path === '/news/master.m3u8') return void res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(MASTER);
      res.writeHead(404).end();
    });
    t = await startTestApp({ JOBS_ENABLED: 'true', CONSOLE_FOUR_EYES: 'false', OPERATOR_ACCESS: 'rights', OPERATOR_COUNTRY_HEADER: 'cf-ipcountry', OPERATOR_DEFAULT_COUNTRY: 'GE' });
    t.container.jobs.start();
    admin = createAdminApp({ config: t.config, logger: createLogger({ log: { level: 'silent' }, env: 'test' }), container: t.container });
    const hash = await new ScryptPasswordHasher({ N: 2 ** 10, r: 8, p: 1 }, 4).hash(PASSWORD);
    await new PgAdminUnitOfWork(t.db).run((tx) => tx.staff.create({ id: newEntityId(), email: 'partners@ops.example', name: 'Partners', role: 'SUPER_ADMIN', passwordHash: hash, now: new Date() }));
    const login = (await request(admin).post('/admin/v1/auth/login').send({ email: 'partners@ops.example', password: PASSWORD }).expect(200)).body as AdminLoginResponse;
    if (login.step !== 'enroll') throw new Error('expected enrolment');
    staff = ((await request(admin).post('/admin/v1/auth/mfa').send({ challenge: login.challenge, code: totpCode(login.secret, totpStep(Date.now())) }).expect(200)).body as AdminSessionDto).token;
    await request(admin).post('/admin/v1/auth/password').set(ops()).send({ currentPassword: PASSWORD, newPassword: 'partners-passphrase-ok' }).expect(204);
    viewer = ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token;

    vendor.upsert('channels', { id: 'news', name: 'Acme News', tvgId: 'news.acme', stream: { url: `${origin.url}/news/master.m3u8` }, rights: [right({ maxQuality: 'hd' })], packages: ['basic'] });
    vendor.upsert('channels', { id: 'broken', name: 'Broken Rights', stream: { url: `${origin.url}/broken.m3u8` }, rights: [right({ territories: ['Georgia'] })] });
    vendor.upsert('vod', { id: 'm1', type: 'movie', title: 'The Heist', year: 1999, genres: ['Action'], stream: { url: `${origin.url}/m1.mp4` }, rights: [right()], packages: ['basic'] });
    vendor.upsert('vod', { id: 's1', type: 'series', title: 'The Show', episodes: [{ id: 'e1', season: 1, episode: 1, title: 'Pilot', stream: { url: `${origin.url}/e1.m3u8` } }] });
    vendor.upsert('packages', { id: 'basic', name: 'Basic' });
  });
  afterAll(async () => {
    await t?.close();
    await origin?.close();
  });

  it('onboards a vendor feed only with a usable signing key', async () => {
    const base = { name: 'Acme Media', slug: 'acme-media', type: 'vendor_feed', credential: { connection: { url: `${origin.url}/feed` } } };
    await request(admin).post('/admin/v1/providers').set(ops()).send(base).expect(400);
    await request(admin).post('/admin/v1/providers').set(ops()).send({ ...base, config: { publicKeys: [{ id: 'k1', key: 'x'.repeat(44) }] } }).expect(400);
    provider = (await request(admin).post('/admin/v1/providers').set(ops()).send({ ...base, config: { publicKeys: [{ id: vendor.keyId, key: vendor.publicKey }] } }).expect(201)).body as ProviderDto;
    expect(provider.feed).toMatchObject({ keyIds: [vendor.keyId] });
    await request(admin).post('/admin/v1/providers').set(ops()).send({ name: 'Plain', type: 'm3u', credential: { connection: { url: `${origin.url}/x.m3u` } }, config: { publicKeys: [{ id: 'k', key: vendor.publicKey }] } }).expect(400);
  });

  it('first sync is a full snapshot: channels to the review queue, VOD and packages stored, bad items journalled', async () => {
    const entry = await waitFor(async () => (await events()).find((event) => event.code === 'sync_ok') ?? null);
    expect(entry.details).toMatchObject({ full: 1, channels: 1, vod: 2, packages: 1, skipped: 1 });
    const skipped = (await events()).find((event) => event.code === 'items_skipped')!;
    expect(JSON.stringify(skipped.details)).toMatch(/georgia/i);
    expect((await current()).feed).toMatchObject({ cursor: vendor.cursor });

    const content = (await request(admin).get(`/admin/v1/providers/${provider.id}/content`).set(ops()).expect(200)).body as ProviderContentDto;
    expect(content).toMatchObject({ movies: 1, series: 1, episodes: 1, packages: [{ externalId: 'basic', name: 'Basic', status: 'active', items: 1 }] });
    const conflicts = (await request(admin).get(`/admin/v1/providers/${provider.id}/conflicts`).set(ops()).expect(200)).body as ProviderConflictsDto;
    expect(conflicts.pendingStreams).toBe(1);
    expect(conflicts.skippedItems[0]?.message).toMatch(/georgia/i);
    // No channel is visible yet: the stream is not matched to a master channel.
    expect((await channels()).channels).toEqual([]);
  });

  it("matching the stream gives the channel the feed's rights: visible where licensed, capped in quality", async () => {
    news = (await request(admin).post('/admin/v1/channels').set(ops()).send({ name: 'Acme News', originCountry: 'GE' }).expect(201)).body as MasterChannelDetailDto;
    const queue = (await request(admin).get(`/admin/v1/streams?providerId=${provider.id}`).set(ops()).expect(200)).body as ProviderStreamPageDto;
    await request(admin).post(`/admin/v1/streams/${queue.items[0]!.id}/review`).set(ops()).send({ action: 'match', channelId: news.id }).expect(200);
    news = (await request(admin).get(`/admin/v1/channels/${news.id}`).set(ops()).expect(200)).body as MasterChannelDetailDto;
    expect(news.grants).toEqual([expect.objectContaining({ territory: 'GE', origin: 'feed', providerId: provider.id, maxQuality: 'hd', status: 'active' })]);

    expect((await channels('GE')).channels.map((channel) => channel.name)).toEqual(['Acme News']);
    expect((await channels('AM')).channels).toEqual([]);

    const plan = (await request(t.app).post('/api/v1/playback').set(as('GE')).send({ content: { type: 'operator', channelId: news.id }, secureContext: false }).expect(200)).body as PlaybackPlanDto;
    const manifest = (await request(t.app).get(plan.candidates[0]!.url).expect(200)).text;
    expect(manifest).toContain('RESOLUTION=640x360');
    expect(manifest).not.toContain('1920x1080'); // licensed up to HD: the 1080p variant is gone
  });

  it('staff grants wider than the feed licenses are listed as conflicts', async () => {
    await request(admin)
      .post(`/admin/v1/channels/${news.id}/grants`)
      .set(ops())
      .send({ territory: 'AM', deviceClasses: ['web'], businessModels: ['subscription'], startAt: new Date(Date.now() - 60_000).toISOString(), contractRef: 'LOCAL-1' })
      .expect(201);
    const conflicts = (await request(admin).get(`/admin/v1/providers/${provider.id}/conflicts`).set(ops()).expect(200)).body as ProviderConflictsDto;
    expect(conflicts.grantsBeyondFeed).toEqual([expect.objectContaining({ channelName: 'Acme News', territory: 'AM', reason: expect.stringContaining('territory AM') })]);
  });

  it('later syncs are incremental: changed rights replace the feed grants, deletions apply', async () => {
    const cursor = vendor.cursor;
    vendor.upsert('channels', { id: 'news', name: 'Acme News', tvgId: 'news.acme', stream: { url: `${origin.url}/news/master.m3u8` }, rights: [right({ territories: ['GE', 'AM'], maxQuality: null })] });
    vendor.remove('vod', 's1');
    const entry = await sync();
    expect(entry).toMatchObject({ code: 'sync_ok', details: expect.objectContaining({ full: 0, channels: 1, grantsAdded: 2, grantsRevoked: 1 }) });
    expect(vendor.requests.at(-1)).toBe(cursor);
    news = (await request(admin).get(`/admin/v1/channels/${news.id}`).set(ops()).expect(200)).body as MasterChannelDetailDto;
    const feedGrants = news.grants.filter((grant) => grant.origin === 'feed' && grant.status === 'active');
    expect(feedGrants.map((grant) => grant.territory).sort()).toEqual(['AM', 'GE']);
    expect(feedGrants.every((grant) => grant.maxQuality === null)).toBe(true);
    expect(((await request(admin).get(`/admin/v1/providers/${provider.id}/content`).set(ops()).expect(200)).body as ProviderContentDto).series).toBe(0);
    // AM is licensed by the feed now: the staff grant is no longer a conflict.
    expect(((await request(admin).get(`/admin/v1/providers/${provider.id}/conflicts`).set(ops()).expect(200)).body as ProviderConflictsDto).grantsBeyondFeed).toEqual([]);
  });

  it('refused feeds change nothing: bad signature, replayed old snapshot', async () => {
    vendor.signing = 'wrong-key';
    expect(await sync()).toMatchObject({ level: 'error', code: 'signature_invalid' });
    vendor.signing = 'valid';
    expect((await current()).sync.status).toBe('failed');

    vendor.upsert('channels', { id: 'news', name: 'Acme News', stream: { url: `${origin.url}/news/master.m3u8` }, rights: [] });
    vendor.generatedAt = new Date(Date.now() - 3_600_000); // older than the feed already applied
    expect(await sync()).toMatchObject({ level: 'error', code: 'stale_feed' });
    vendor.generatedAt = null;
    // Still licensed in GE: the refused feeds revoked nothing.
    expect((await channels('GE')).channels.map((channel) => channel.name)).toEqual(['Acme News']);

    // A current, valid feed that withdraws the rights takes the channel off the air.
    expect(await sync()).toMatchObject({ code: 'sync_ok' });
    expect((await channels('GE')).channels).toEqual([]);
  });
});

import type {
  AccountBillingDto,
  AdminLoginResponse,
  AdminSessionDto,
  AuditPageDto,
  AuthSessionDto,
  CheckoutQuoteDto,
  CheckoutStartedDto,
  CheckoutStatusDto,
  DeviceDto,
  MasterChannelDetailDto,
  OperatorChannelListDto,
  OperatorVodDetailDto,
  OperatorVodPageDto,
  PackageDetailDto,
  PackageOfferDto,
  PlanChangeQuoteDto,
  PlaybackPlanDto,
  PlaybackSessionDto,
  PromoCodeDto,
  ProviderDto,
  ProviderPackageOptionDto,
  ProviderSyncEventDto,
  SubscriptionDto,
} from '@ziptv/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { totpCode, totpStep } from '../domain/admin/totp.js';
import { newEntityId } from '../domain/shared/ids.js';
import type { FakePaymentProcessor } from '../infrastructure/billing/fake-processor.js';
import { ScryptPasswordHasher } from '../infrastructure/crypto/password-hasher.js';
import { createLogger } from '../infrastructure/logger.js';
import { PgAdminUnitOfWork } from '../infrastructure/persistence/postgres/repositories/admin.repository.js';
import { startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';
import { ReferenceVendorFeed } from '../test/reference-vendor-feed.js';
import { createAdminApp } from './admin/admin-app.js';

/**
 * Commercial catalogue end to end (Phase 17): plans are sets of entitlements configured in the
 * console — channels, VOD mode, quality, catch-up, streams — priced per country, sold with promo
 * codes, versioned when people hold them (grandfathering), changed mid-period with proration; one
 * entitlement engine decides playback, the channel list and the VOD catalogue's badges.
 */

const PASSWORD = 'initial-password-123';
const DAY = 86_400_000;
const MASTER = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', 'low.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720', 'mid.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080', 'high.m3u8'].join('\n');

describe.skipIf(!TEST_DATABASE_URL)('Commercial catalogue: plans, prices, promos, versions, one entitlement engine', () => {
  let t: TestApp;
  let admin: Express;
  let origin: FakeOrigin;
  let fake: FakePaymentProcessor;
  let staff = '';
  const vendor = new ReferenceVendorFeed('studio-one');
  const ops = () => ({ Authorization: `Bearer ${staff}` });

  let news: MasterChannelDetailDto;
  let sport: MasterChannelDetailDto;
  let basic: PackageDetailDto;
  let premium: PackageDetailDto;
  let gold: PackageDetailDto;

  interface Account {
    token: string;
    userId: string;
    devices: DeviceDto[];
  }
  let alice: Account;
  let bob: Account;

  beforeAll(async () => {
    origin = await startOrigin((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/feed') return vendor.handle(req, res);
      if (path?.endsWith('.m3u8')) return void res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(MASTER);
      res.writeHead(404).end();
    });
    t = await startTestApp({ JOBS_ENABLED: 'true', CONSOLE_FOUR_EYES: 'false', PROBES_ENABLED: 'false', OPERATOR_COUNTRY_HEADER: 'cf-ipcountry', OPERATOR_DEFAULT_COUNTRY: 'GE' });
    t.container.jobs.start();
    fake = t.container.commerce.fakeProcessor!;
    admin = createAdminApp({ config: t.config, logger: createLogger({ log: { level: 'silent' }, env: 'test' }), container: t.container });
    const hash = await new ScryptPasswordHasher({ N: 2 ** 10, r: 8, p: 1 }, 4).hash(PASSWORD);
    await new PgAdminUnitOfWork(t.db).run((tx) => tx.staff.create({ id: newEntityId(), email: 'plans@ops.example', name: 'Plans', role: 'SUPER_ADMIN', passwordHash: hash, now: new Date() }));
    const login = (await request(admin).post('/admin/v1/auth/login').send({ email: 'plans@ops.example', password: PASSWORD }).expect(200)).body as AdminLoginResponse;
    if (login.step !== 'enroll') throw new Error('expected enrolment');
    staff = ((await request(admin).post('/admin/v1/auth/mfa').send({ challenge: login.challenge, code: totpCode(login.secret, totpStep(Date.now())) }).expect(200)).body as AdminSessionDto).token;
    await request(admin).post('/admin/v1/auth/password').set(ops()).send({ currentPassword: PASSWORD, newPassword: 'plans-passphrase-is-ok' }).expect(204);

    // Two licensed channels (HLS with 360p/720p/1080p), catch-up licensed for 7 days.
    news = (await request(admin).post('/admin/v1/channels').set(ops()).send({ name: 'Plan News', originCountry: 'GE', globalUid: 'news.plans' }).expect(201)).body as MasterChannelDetailDto;
    sport = (await request(admin).post('/admin/v1/channels').set(ops()).send({ name: 'Plan Sport', originCountry: 'GE', globalUid: 'sport.plans' }).expect(201)).body as MasterChannelDetailDto;
    const provider = (
      await request(admin)
        .post('/admin/v1/providers')
        .set(ops())
        .send({ name: 'Channel Licensor', type: 'mock', config: { channels: [{ id: 'n', name: 'Plan News', tvgId: 'news.plans', url: `${origin.url}/news/master.m3u8` }, { id: 's', name: 'Plan Sport', tvgId: 'sport.plans', url: `${origin.url}/sport/master.m3u8` }] } })
        .expect(201)
    ).body as ProviderDto;
    await waitFor(async () => (((await request(admin).get('/admin/v1/providers').set(ops())).body as ProviderDto[]).find((p) => p.id === provider.id)?.sync.lastSuccessAt ? true : null));
    const rights = { territory: '*', deviceClasses: ['web'], businessModels: ['subscription'], startAt: new Date(Date.now() - 30 * DAY).toISOString(), contractRef: 'LIC-17', catchupDays: 7 };
    await request(admin).post(`/admin/v1/channels/${news.id}/grants`).set(ops()).send(rights).expect(201);
    await request(admin).post(`/admin/v1/channels/${sport.id}/grants`).set(ops()).send(rights).expect(201);

    // A vendor feed with films: one in its "gold" package, one in no package, one licensed only in the US.
    const right = (territories: string[]) => ({ territories, devices: ['web'], models: ['subscription'], start: new Date(Date.now() - DAY).toISOString(), catchupDays: 0 });
    vendor.upsert('vod', { id: 'm1', type: 'movie', title: 'Gold Heist', stream: { url: `${origin.url}/m1.m3u8` }, rights: [right(['GE', 'DE'])], packages: ['gold'] });
    vendor.upsert('vod', { id: 'm2', type: 'movie', title: 'Open Road', stream: { url: `${origin.url}/m2.m3u8` }, rights: [right(['*'])] });
    vendor.upsert('vod', { id: 'm3', type: 'movie', title: 'Far Away', stream: { url: `${origin.url}/m3.m3u8` }, rights: [right(['US'])] });
    vendor.upsert('packages', { id: 'gold', name: 'Gold Films' });
    const feed = (await request(admin)
      .post('/admin/v1/providers')
      .set(ops())
      .send({ name: 'Studio One', slug: 'studio-one', type: 'vendor_feed', credential: { connection: { url: `${origin.url}/feed` } }, config: { publicKeys: [{ id: vendor.keyId, key: vendor.publicKey }] } })
      .expect(201)).body as ProviderDto;
    await waitFor(async () => ((await request(admin).get(`/admin/v1/providers/${feed.id}/events`).set(ops())).body as ProviderSyncEventDto[]).find((event) => event.code === 'sync_ok') ?? null);
  });
  afterAll(async () => {
    await t?.close();
    await origin?.close();
  });

  // --- helpers --------------------------------------------------------------------------------------

  const as = (account: { token: string }, country = 'GE') => ({ Authorization: `Bearer ${account.token}`, 'cf-ipcountry': country });
  const register = async (email: string): Promise<Account> => {
    const session = (await request(t.app).post('/api/v1/auth/register').send({ email, password: 'correct-horse-battery-9' }).expect(201)).body as AuthSessionDto;
    const account: Account = { token: session.token, userId: session.user.userId, devices: [] };
    account.devices.push((await request(t.app).post('/api/v1/devices').set(as(account)).send({ key: newEntityId() + newEntityId(), name: 'Web', platform: 'web' }).expect(201)).body as DeviceDto);
    return account;
  };
  const subscribe = async (who: Account, packageId: string, promoCode?: string) => {
    const started = (await request(t.app).post('/api/v1/billing/checkout').set(as(who)).send({ packageId, ...(promoCode ? { promoCode } : {}) }).expect(201)).body as CheckoutStartedDto;
    const page = new URL(started.redirectUrl).pathname;
    const html = (await request(t.app).get(page).expect(200)).text;
    await request(t.app).post(`${page}/pay`).type('form').send({}).expect(303);
    await waitFor(async () => (((await request(t.app).get(`/api/v1/billing/checkout/${started.checkoutId}`).set(as(who)).expect(200)).body as CheckoutStatusDto).status === 'completed' ? true : null));
    return { html, ref: fake.subscriptionOf(page.split('/').pop()!)! };
  };
  const account = async (who: Account) => (await request(t.app).get('/api/v1/billing/account').set(as(who)).expect(200)).body as AccountBillingDto;
  const start = (who: Account, channelId: string, archive?: { start: string; end: string }) =>
    request(t.app).post('/api/v1/operator/playback/sessions').set(as(who)).send({ channelId, deviceId: who.devices[0]!.id, secureContext: false, ...(archive ? { archive } : {}) });
  const masterOf = async (session: PlaybackSessionDto) => (await request(t.app).get(session.plan.candidates[0]!.url).expect(200)).text;
  const vod = async (who: Account, country = 'GE') => (await request(t.app).get('/api/v1/operator/vod?type=movie').set(as(who, country)).expect(200)).body as OperatorVodPageDto;

  // --- 17.1 / 17.3: plans as entitlement sets, priced per country ------------------------------------

  it('configures plans in the console: VOD mode, quality, catch-up, regional prices — validated', async () => {
    const options = (await request(admin).get('/admin/v1/provider-packages').set(ops()).expect(200)).body as ProviderPackageOptionDto[];
    const goldPackage = options.find((option) => option.name === 'Gold Films')!;
    expect(goldPackage).toMatchObject({ providerName: 'Studio One', items: 1, status: 'active' });

    const create = (body: Record<string, unknown>) => request(admin).post('/admin/v1/packages').set(ops()).send({ billingPeriod: 'month', maxDevices: 3, maxStreams: 2, currency: 'GEL', ...body });
    await create({ name: 'Broken', priceMinor: 100, vodMode: 'package' }).expect(400);
    await create({ name: 'Broken', priceMinor: 100, vodMode: 'package', vodPackages: [newEntityId()] }).expect(400);
    await create({ name: 'Broken', priceMinor: 100, vodMode: 'none', vodPackages: [goldPackage.id] }).expect(400);
    await create({ name: 'Broken', priceMinor: 100, prices: [{ country: 'X1', currency: 'EUR', priceMinor: 1 }] }).expect(400);
    await create({ name: 'Broken', priceMinor: 100, prices: [{ country: 'DE', currency: 'EUR', priceMinor: 1 }, { country: 'de', currency: 'EUR', priceMinor: 2 }] }).expect(400);

    const draftBasic = (await create({ name: 'Basic', priceMinor: 999, maxQuality: 'hd', catchupDays: 1 }).expect(201)).body as PackageDetailDto;
    expect(draftBasic).toMatchObject({ vodMode: 'none', maxQuality: 'hd', catchupDays: 1, version: 1, familyId: draftBasic.id, versions: [{ version: 1, holders: 0 }] });
    const draftPremium = (await create({ name: 'Premium', priceMinor: 1999, vodMode: 'included', prices: [{ country: 'de', currency: 'eur', priceMinor: 799 }] }).expect(201)).body as PackageDetailDto;
    expect(draftPremium.prices).toEqual([{ country: 'DE', currency: 'EUR', priceMinor: 799 }]);
    const draftGold = (await create({ name: 'Gold Films', priceMinor: 1499, vodMode: 'package', vodPackages: [goldPackage.id] }).expect(201)).body as PackageDetailDto;

    const activate = async (pkg: PackageDetailDto, channelIds: string[]) => (await request(admin).patch(`/admin/v1/packages/${pkg.id}`).set(ops()).send({ status: 'active', channelIds }).expect(200)).body as PackageDetailDto;
    basic = await activate(draftBasic, [news.id]);
    premium = await activate(draftPremium, [news.id, sport.id]);
    gold = await activate(draftGold, [news.id]);
    // A draft changes in place: still version 1.
    expect(basic.version).toBe(1);
  });

  it('prices follow the server-determined country; the offer says what the plan includes', async () => {
    alice = await register('alice@plans.example');
    const offers = (country: string) => request(t.app).get('/api/v1/billing/packages').set(as(alice, country)).expect(200);
    const inGeorgia = (await offers('GE')).body as PackageOfferDto[];
    const inGermany = (await offers('DE')).body as PackageOfferDto[];
    expect(inGeorgia.find((offer) => offer.id === premium.id)).toMatchObject({ priceMinor: 1999, currency: 'GEL', priceCountry: null, vodMode: 'included', maxQuality: null, catchupDays: null, channels: 2 });
    expect(inGermany.find((offer) => offer.id === premium.id)).toMatchObject({ priceMinor: 799, currency: 'EUR', priceCountry: 'DE' });
    expect(inGermany.find((offer) => offer.id === basic.id)).toMatchObject({ priceMinor: 999, currency: 'GEL', maxQuality: 'hd', catchupDays: 1, vodMode: 'none' });
  });

  // --- 17.3: promo codes (four-eyes like a price) ------------------------------------------------------

  it('promo codes: created like a price, quoted, applied to the first payment, used once per account', async () => {
    await request(admin).post('/admin/v1/promo-codes').set(ops()).send({ code: 'BAD', kind: 'percent', value: 150 }).expect(400);
    await request(admin).post('/admin/v1/promo-codes').set(ops()).send({ code: 'EUROS', kind: 'amount', value: 100 }).expect(400);
    const promo = (await request(admin).post('/admin/v1/promo-codes').set(ops()).send({ code: 'welcome-50', kind: 'percent', value: 50, families: [premium.familyId], maxRedemptions: 100 }).expect(201)).body as PromoCodeDto;
    expect(promo).toMatchObject({ code: 'WELCOME-50', active: true, redemptions: 0 });
    await request(admin).post('/admin/v1/promo-codes').set(ops()).send({ code: 'WELCOME-50', kind: 'percent', value: 10 }).expect(409);

    const quote = async (packageId: string, promoCode?: string) => (await request(t.app).post('/api/v1/billing/quote').set(as(alice)).send({ packageId, promoCode }).expect(200)).body as CheckoutQuoteDto;
    expect(await quote(premium.id, ' welcome-50 ')).toMatchObject({ priceMinor: 1999, currency: 'GEL', promo: { code: 'WELCOME-50', discountMinor: 1000, firstPaymentMinor: 999 }, promoProblem: null });
    expect(await quote(basic.id, 'WELCOME-50')).toMatchObject({ promo: null, promoProblem: 'not_for_plan' });
    expect(await quote(premium.id, 'NOPE')).toMatchObject({ promo: null, promoProblem: 'unknown' });
    const refused = await request(t.app).post('/api/v1/billing/checkout').set(as(alice)).send({ packageId: basic.id, promoCode: 'WELCOME-50' }).expect(422);
    expect(refused.body.error).toMatchObject({ code: 'PROMO_INVALID', details: { problem: 'not_for_plan' } });

    bob = await register('bob@plans.example');
    const { html, ref } = await subscribe(bob, premium.id, 'WELCOME-50');
    expect(html).toContain('first payment 9.99 GEL (promo)');
    const billing = await account(bob);
    expect(billing.invoices[0]).toMatchObject({ amountMinor: 999, currency: 'GEL' });
    expect(billing.subscription).toMatchObject({ package: { id: premium.id }, price: { amountMinor: 1999, currency: 'GEL' }, grandfathered: false });
    // The next renewal is at the full price.
    fake.renew(ref);
    await waitFor(async () => ((await account(bob)).invoices.length === 2 ? true : null));
    expect((await account(bob)).invoices[0]).toMatchObject({ amountMinor: 1999 });
    expect((await request(admin).get('/admin/v1/promo-codes').set(ops()).expect(200)).body as PromoCodeDto[]).toEqual([expect.objectContaining({ code: 'WELCOME-50', redemptions: 1 })]);
    expect((await request(t.app).post('/api/v1/billing/quote').set(as(bob)).send({ packageId: premium.id, promoCode: 'WELCOME-50' }).expect(200)).body).toMatchObject({ promoProblem: 'already_used' });

    // Stopping a code acts at once (it only narrows); it cannot be re-opened by a PATCH.
    await request(admin).patch(`/admin/v1/promo-codes/${promo.id}`).set(ops()).send({ active: true }).expect(400);
    await request(admin).patch(`/admin/v1/promo-codes/${promo.id}`).set(ops()).send({ active: false }).expect(200);
    expect(await quote(premium.id, 'WELCOME-50')).toMatchObject({ promoProblem: 'inactive' });
  });

  // --- 17.4: one engine — playback limits, the channel list, VOD badges ---------------------------------

  it('the plan narrows the licence in playback: quality ceiling in the stream, catch-up days', async () => {
    await subscribe(alice, basic.id);
    const session = (await start(alice, news.id).expect(201)).body as PlaybackSessionDto;
    const master = await masterOf(session);
    expect(master).toContain('RESOLUTION=1280x720');
    expect(master).not.toContain('RESOLUTION=1920x1080'); // Basic is HD (720p)

    // Licensed for 7 days, but Basic includes 1.
    const twoDaysAgo = { start: new Date(Date.now() - 2 * DAY - 3600_000).toISOString(), end: new Date(Date.now() - 2 * DAY).toISOString() };
    const refused = await start(alice, news.id, twoDaysAgo).expect(403);
    expect(refused.body.error.details).toMatchObject({ reason: 'catchup_not_in_plan', catchupDays: 1 });
    await request(t.app).delete(`/api/v1/operator/playback/sessions/${session.playbackSessionId}`).set(as(alice)).expect(204);

    // Bob (Premium, no ceiling) gets every variant.
    const premiumSession = (await start(bob, news.id).expect(201)).body as PlaybackSessionDto;
    expect(await masterOf(premiumSession)).toContain('RESOLUTION=1920x1080');
    await request(t.app).delete(`/api/v1/operator/playback/sessions/${premiumSession.playbackSessionId}`).set(as(bob)).expect(204);

    // The channel list: Sport is locked for Alice and offered with the plans that carry it.
    const list = (await request(t.app).get('/api/v1/operator/channels').set(as(alice)).expect(200)).body as OperatorChannelListDto;
    expect(list.channels.find((channel) => channel.id === news.id)).toMatchObject({ locked: false });
    expect(list.channels.find((channel) => channel.id === sport.id)).toMatchObject({ locked: true, packages: [{ slug: 'premium', name: 'Premium' }] });
  });

  it('VOD: included / package / none decided by the same engine; the catalogue says “in your plan” or which plans would open it', async () => {
    const forAlice = await vod(alice); // Basic: no VOD
    expect(forAlice.total).toBe(2); // Far Away is licensed in the US only
    const heist = forAlice.items.find((item) => item.title === 'Gold Heist')!;
    const road = forAlice.items.find((item) => item.title === 'Open Road')!;
    expect(heist).toMatchObject({ access: 'upgrade', plans: expect.arrayContaining([{ slug: 'premium', name: 'Premium' }, { slug: 'gold-films', name: 'Gold Films' }]) });
    expect(heist.plans).toHaveLength(2);
    expect(road).toMatchObject({ access: 'upgrade', plans: [{ slug: 'premium', name: 'Premium' }] });

    const forBob = await vod(bob); // Premium: VOD included
    expect(forBob.items.every((item) => item.access === 'included' && item.plans.length === 0)).toBe(true);
    expect((await vod(bob, 'US')).items.map((item) => item.title)).toEqual(['Far Away', 'Open Road']);
    const search = (await request(t.app).get('/api/v1/operator/vod?q=road').set(as(bob)).expect(200)).body as OperatorVodPageDto;
    expect(search.items.map((item) => item.title)).toEqual(['Open Road']);

    // Playback asks the same engine: Bob's plan includes the film, Alice's does not (and says which plans would).
    const play = (who: Account, vodId: string) => request(t.app).post('/api/v1/playback').set(as(who)).send({ content: { type: 'operator_vod', vodId }, secureContext: false });
    const plan = (await play(bob, road.id).expect(200)).body as PlaybackPlanDto;
    expect(plan.content).toMatchObject({ mode: 'vod', title: 'Open Road', ref: { type: 'operator_vod', vodId: road.id } });
    expect(plan.candidates[0]!.via).toBe('proxy');
    expect((await request(t.app).get(plan.candidates[0]!.url).expect(200)).text).toContain('#EXTM3U');
    const refused = (await play(alice, road.id).expect(403)).body;
    expect(refused.error).toMatchObject({ code: 'NOT_ENTITLED', details: { reason: 'not_in_plan', packages: [{ slug: 'premium', name: 'Premium' }] } });
    const detail = (await request(t.app).get(`/api/v1/operator/vod/${heist.id}`).set(as(alice)).expect(200)).body as OperatorVodDetailDto;
    expect(detail).toMatchObject({ title: 'Gold Heist', access: 'upgrade', episodes: [] });
    // Licensed elsewhere only: it does not exist here.
    const far = (await vod(bob, 'US')).items.find((item) => item.title === 'Far Away')!;
    await request(t.app).get(`/api/v1/operator/vod/${far.id}`).set(as(bob)).expect(404);
    await play(bob, far.id).expect(404);
  });

  // --- 17.3: proration ---------------------------------------------------------------------------------

  it('plan change mid-period: quoted with proration, applied now, the engine follows at once', async () => {
    const quote = (await request(t.app).post('/api/v1/billing/subscription/change/quote').set(as(alice)).send({ packageId: gold.id }).expect(200)).body as PlanChangeQuoteDto;
    // A fresh period: almost all of it is left — credit ~9.99, charge ~14.99.
    expect(quote).toMatchObject({ from: { packageId: basic.id, priceMinor: 999, currency: 'GEL' }, to: { packageId: gold.id, priceMinor: 1499, currency: 'GEL' }, carryMinor: 0 });
    expect(quote.remaining).toBeGreaterThan(0.99);
    expect(quote.dueNowMinor).toBe(quote.chargeMinor - quote.creditMinor);
    expect(quote.dueNowMinor).toBeGreaterThanOrEqual(495);
    await request(t.app).post('/api/v1/billing/subscription/change/quote').set(as(alice)).send({ packageId: basic.id }).expect(409);

    const changed = (await request(t.app).post('/api/v1/billing/subscription/change').set(as(alice)).send({ packageId: gold.id }).expect(200)).body as SubscriptionDto;
    expect(changed).toMatchObject({ package: { id: gold.id }, price: { amountMinor: 1499, currency: 'GEL' }, status: 'active' });
    // Gold opens the vendor's gold package: Gold Heist is in Alice's plan now; Open Road is still an upgrade.
    const after = await vod(alice);
    expect(after.items.find((item) => item.title === 'Gold Heist')).toMatchObject({ access: 'included' });
    expect(after.items.find((item) => item.title === 'Open Road')).toMatchObject({ access: 'upgrade' });
    // The processor collected the difference (its webhook records the invoice).
    await waitFor(async () => ((await account(alice)).invoices.some((invoice) => invoice.amountMinor === quote.dueNowMinor) ? true : null));
    const { processor_ref: ref } = await t.db.selectFrom('subscriptions').select('processor_ref').where('id', '=', changed.id).executeTakeFirstOrThrow();
    expect(fake.priceOf(ref)).toMatchObject({ amountMinor: 1499, currency: 'GEL', credit: 0 });
  });

  // --- 17.2: versions and grandfathering ---------------------------------------------------------------

  it('changing the terms of a plan people hold creates a new version; holders keep theirs', async () => {
    const carol = await register('carol@plans.example');
    await subscribe(carol, basic.id);
    // Name/description change in place.
    const renamed = (await request(admin).patch(`/admin/v1/packages/${basic.id}`).set(ops()).send({ description: 'Live channels in HD' }).expect(200)).body as PackageDetailDto;
    expect(renamed).toMatchObject({ id: basic.id, version: 1 });

    // A price rise: version 2 takes over the plan; Carol keeps version 1 and its price.
    const v2 = (await request(admin).patch(`/admin/v1/packages/${basic.id}`).set(ops()).send({ priceMinor: 1299, catchupDays: 3 }).expect(200)).body as PackageDetailDto;
    expect(v2).toMatchObject({ slug: 'basic', version: 2, familyId: basic.familyId, priceMinor: 1299, catchupDays: 3, maxQuality: 'hd', status: 'active', channelIds: [news.id], holders: 0 });
    expect(v2.id).not.toBe(basic.id);
    expect(v2.versions.map((version) => [version.version, version.status, version.holders])).toEqual([
      [2, 'active', 0],
      [1, 'retired', 1],
    ]);
    const v1 = (await request(admin).get(`/admin/v1/packages/${basic.id}`).set(ops()).expect(200)).body as PackageDetailDto;
    expect(v1).toMatchObject({ slug: 'basic-v1', status: 'retired', supersededBy: v2.id, priceMinor: 999 });
    await request(admin).patch(`/admin/v1/packages/${basic.id}`).set(ops()).send({ priceMinor: 1 }).expect(409);

    const carolSub = (await account(carol)).subscription!;
    expect(carolSub).toMatchObject({ package: { id: basic.id }, price: { amountMinor: 999, currency: 'GEL' }, grandfathered: true });
    // Carol still watches under version 1 (its catch-up: 1 day).
    const twoDaysAgo = { start: new Date(Date.now() - 2 * DAY - 3600_000).toISOString(), end: new Date(Date.now() - 2 * DAY).toISOString() };
    expect((await start(carol, news.id, twoDaysAgo).expect(403)).body.error.details).toMatchObject({ catchupDays: 1 });
    // New buyers see version 2 only.
    const offers = (await request(t.app).get('/api/v1/billing/packages').set(as(carol)).expect(200)).body as PackageOfferDto[];
    expect(offers.filter((offer) => offer.slug.startsWith('basic')).map((offer) => [offer.id, offer.priceMinor])).toEqual([[v2.id, 1299]]);

    // Channels are shared by every version: adding Sport to v2 gives it to Carol (v1) too.
    await request(admin).patch(`/admin/v1/packages/${v2.id}`).set(ops()).send({ channelIds: [news.id, sport.id] }).expect(200);
    const list = (await request(t.app).get('/api/v1/operator/channels').set(as(carol)).expect(200)).body as OperatorChannelListDto;
    expect(list.channels.find((channel) => channel.id === sport.id)).toMatchObject({ locked: false });

    const audit = (await request(admin).get('/admin/v1/audit?targetType=package').set(ops()).expect(200)).body as AuditPageDto;
    expect(audit.items.find((item) => item.action === 'package.versioned')?.details).toMatchObject({ previousVersion: basic.id, version: 2, holdersKept: 1 });
  });
});

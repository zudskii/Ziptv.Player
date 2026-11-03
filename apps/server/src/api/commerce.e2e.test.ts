import type {
  AccountBillingDto,
  AdminLoginResponse,
  AdminSessionDto,
  AuditPageDto,
  AuthSessionDto,
  CheckoutStartedDto,
  CheckoutStatusDto,
  ConcurrencyLimitDetails,
  DeviceDto,
  EntitlementDto,
  MasterChannelDetailDto,
  OperatorChannelListDto,
  PackageDetailDto,
  PackageOfferDto,
  PaymentEventDto,
  PlaybackSessionDto,
  ProviderDto,
  RightsGrantDto,
  SessionDto,
  SubscriptionDto,
  UserBillingDto,
} from '@ziptv/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Clock } from '../application/ports/clock.js';
import { totpCode, totpStep } from '../domain/admin/totp.js';
import { newEntityId } from '../domain/shared/ids.js';
import type { FakePaymentProcessor } from '../infrastructure/billing/fake-processor.js';
import { ScryptPasswordHasher } from '../infrastructure/crypto/password-hasher.js';
import { createLogger } from '../infrastructure/logger.js';
import { PgAdminUnitOfWork } from '../infrastructure/persistence/postgres/repositories/admin.repository.js';
import { startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';
import { createAdminApp } from './admin/admin-app.js';

/**
 * Commerce and playback authorization end to end (Phase 8, ZP-ENT-07/08/09). The gate: no stream
 * without an active entitlement, and none of the checks — subscription state, device, concurrent
 * streams, country, rights — can be skipped. Payments go through the built-in fake processor,
 * whose webhooks arrive asynchronously, like a real one's.
 */

const TS = Buffer.alloc(188 * 3, 0xff);
[0, 188, 376].forEach((offset) => (TS[offset] = 0x47));
const PASSWORD = 'initial-password-123';
const DAY = 86_400_000;

describe.skipIf(!TEST_DATABASE_URL)('Commerce and playback authorization', () => {
  let t: TestApp;
  let admin: Express;
  let origin: FakeOrigin;
  let fake: FakePaymentProcessor;
  let staff = '';
  let offsetMs = 0;
  const clock: Clock = { now: () => new Date(Date.now() + offsetMs) };
  const ops = () => ({ Authorization: `Bearer ${staff}` });

  let news: MasterChannelDetailDto;
  let fast: MasterChannelDetailDto;
  let newsGrant: RightsGrantDto;
  let basic: PackageDetailDto;
  let plus: PackageDetailDto;

  /** A subscriber: an account with its own devices. */
  interface Account {
    token: string;
    userId: string;
    devices: DeviceDto[];
  }
  let alice: Account;
  let bob: Account;

  beforeAll(async () => {
    origin = await startOrigin((req, res) => {
      if ((req.url ?? '').split('?')[0]?.endsWith('.ts')) return void res.writeHead(200, { 'content-type': 'video/mp2t' }).end(TS);
      res.writeHead(404).end();
    });
    t = await startTestApp({ JOBS_ENABLED: 'true', CONSOLE_FOUR_EYES: 'false', PROBES_ENABLED: 'false', OPERATOR_COUNTRY_HEADER: 'cf-ipcountry', OPERATOR_DEFAULT_COUNTRY: 'GE', DEFAULT_MAX_STREAMS: '1' }, { clock });
    t.container.jobs.start();
    fake = t.container.commerce.fakeProcessor!;
    admin = createAdminApp({ config: t.config, logger: createLogger({ log: { level: 'silent' }, env: 'test' }), container: t.container });

    const hash = await new ScryptPasswordHasher({ N: 2 ** 10, r: 8, p: 1 }, 4).hash(PASSWORD);
    await new PgAdminUnitOfWork(t.db).run((tx) => tx.staff.create({ id: newEntityId(), email: 'root@ops.example', name: 'Root', role: 'SUPER_ADMIN', passwordHash: hash, now: new Date() }));
    const login = (await request(admin).post('/admin/v1/auth/login').send({ email: 'root@ops.example', password: PASSWORD }).expect(200)).body as AdminLoginResponse;
    if (login.step !== 'enroll') throw new Error('expected enrolment');
    staff = ((await request(admin).post('/admin/v1/auth/mfa').send({ challenge: login.challenge, code: totpCode(login.secret, totpStep(Date.now())) }).expect(200)).body as AdminSessionDto).token;
    await request(admin).post('/admin/v1/auth/password').set(ops()).send({ currentPassword: PASSWORD, newPassword: 'root-passphrase-is-long' }).expect(204);

    // Two licensed channels from one provider: a premium one (subscription rights, Georgia) and a free FAST one.
    news = (await request(admin).post('/admin/v1/channels').set(ops()).send({ name: 'Premium News', originCountry: 'GE', globalUid: 'news.tv' }).expect(201)).body as MasterChannelDetailDto;
    fast = (await request(admin).post('/admin/v1/channels').set(ops()).send({ name: 'Free Movies', originCountry: 'GE', globalUid: 'fast.tv' }).expect(201)).body as MasterChannelDetailDto;
    const provider = (
      await request(admin)
        .post('/admin/v1/providers')
        .set(ops())
        .send({ name: 'Licensor', type: 'mock', config: { channels: [{ id: 'n', name: 'Premium News', tvgId: 'news.tv', url: `${origin.url}/live/news.ts` }, { id: 'f', name: 'Free Movies', tvgId: 'fast.tv', url: `${origin.url}/live/fast.ts` }] } })
        .expect(201)
    ).body as ProviderDto;
    await waitFor(async () => {
      const current = ((await request(admin).get('/admin/v1/providers').set(ops())).body as ProviderDto[]).find((p) => p.id === provider.id)!;
      return current.sync.lastSuccessAt ? current : null;
    });
    const rights = { deviceClasses: ['web'], startAt: new Date(Date.now() - 60_000).toISOString(), contractRef: 'LIC-2026-008' };
    newsGrant = (await request(admin).post(`/admin/v1/channels/${news.id}/grants`).set(ops()).send({ ...rights, territory: 'GE', businessModels: ['subscription'] }).expect(201)).body as RightsGrantDto;
    await request(admin).post(`/admin/v1/channels/${fast.id}/grants`).set(ops()).send({ ...rights, territory: '*', businessModels: ['fast'] }).expect(201);
  });
  afterAll(async () => {
    await t?.close();
    await origin?.close();
  });

  // --- helpers --------------------------------------------------------------------------------------

  const as = (account: { token: string }, headers: Record<string, string> = {}) => ({ Authorization: `Bearer ${account.token}`, ...headers });
  const register = async (email: string): Promise<Account> => {
    const session = (await request(t.app).post('/api/v1/auth/register').send({ email, password: 'correct-horse-battery-9' }).expect(201)).body as AuthSessionDto;
    return { token: session.token, userId: session.user.userId, devices: [] };
  };
  const addDevice = async (account: Account, name: string) => {
    const device = (await request(t.app).post('/api/v1/devices').set(as(account)).send({ key: newEntityId() + newEntityId(), name, platform: 'web' }).expect(201)).body as DeviceDto;
    account.devices.push(device);
    return device;
  };
  const start = (account: Account, channelId: string, deviceId = account.devices[0]!.id, headers: Record<string, string> = {}) =>
    request(t.app).post('/api/v1/operator/playback/sessions').set(as(account, headers)).send({ channelId, deviceId, secureContext: false });
  const heartbeat = (account: Account, id: string, headers: Record<string, string> = {}) => request(t.app).post(`/api/v1/operator/playback/sessions/${id}/heartbeat`).set(as(account, headers)).send({});
  const stop = (account: Account, id: string) => request(t.app).delete(`/api/v1/operator/playback/sessions/${id}`).set(as(account));
  /** Status of the stream link the session handed out (the proxy is the last line of defence). */
  const proxy = async (session: PlaybackSessionDto) => (await request(t.app).get(session.plan.candidates[0]!.url)).status;
  const account = async (who: Account) => (await request(t.app).get('/api/v1/billing/account').set(as(who)).expect(200)).body as AccountBillingDto;
  const subscribe = async (who: Account, packageId: string) => {
    const started = (await request(t.app).post('/api/v1/billing/checkout').set(as(who)).send({ packageId }).expect(201)).body as CheckoutStartedDto;
    const page = new URL(started.redirectUrl).pathname;
    const paid = await request(t.app).post(`${page}/pay`).type('form').send({}).expect(303);
    expect(paid.headers.location).toContain(`/billing/return?checkout=${started.checkoutId}`);
    const status = await waitFor(async () => {
      const current = (await request(t.app).get(`/api/v1/billing/checkout/${started.checkoutId}`).set(as(who)).expect(200)).body as CheckoutStatusDto;
      return current.status === 'completed' ? current : null;
    });
    return { ...status, ref: fake.subscriptionOf(page.split('/').pop()!)! };
  };
  const live = async (who: Account) => (await account(who)).subscription;

  // --- catalog of plans -----------------------------------------------------------------------------

  it('sets up packages in the console: draft until activated, channels attached, every change audited', async () => {
    const created = (await request(admin).post('/admin/v1/packages').set(ops()).send({ name: 'Basic', priceMinor: 999, currency: 'gel', billingPeriod: 'month', maxDevices: 2, maxStreams: 1 }).expect(201)).body as PackageDetailDto;
    expect(created).toMatchObject({ slug: 'basic', currency: 'GEL', status: 'draft', channelIds: [] });
    await request(admin).post('/admin/v1/packages').set(ops()).send({ name: 'Basic', priceMinor: 1, currency: 'GEL', billingPeriod: 'month', maxDevices: 1, maxStreams: 1 }).expect(409);
    basic = (await request(admin).patch(`/admin/v1/packages/${created.id}`).set(ops()).send({ status: 'active', channelIds: [news.id] }).expect(200)).body as PackageDetailDto;
    expect(basic).toMatchObject({ status: 'active', channelIds: [news.id], channels: 1 });
    await request(admin).patch(`/admin/v1/packages/${created.id}`).set(ops()).send({ channelIds: [newEntityId()] }).expect(400);

    const draft = (await request(admin).post('/admin/v1/packages').set(ops()).send({ name: 'Plus', priceMinor: 1999, currency: 'GEL', billingPeriod: 'month', trialDays: 7, maxDevices: 4, maxStreams: 2 }).expect(201)).body as PackageDetailDto;
    plus = (await request(admin).patch(`/admin/v1/packages/${draft.id}`).set(ops()).send({ status: 'active', channelIds: [news.id] }).expect(200)).body as PackageDetailDto;

    const audit = (await request(admin).get('/admin/v1/audit?targetType=package').set(ops()).expect(200)).body as AuditPageDto;
    expect(audit.items.map((item) => item.action)).toEqual(expect.arrayContaining(['package.created', 'package.updated']));
  });

  it('shows plans and locked channels to a guest, but only accounts can buy', async () => {
    const guest = { token: ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token };
    const offers = (await request(t.app).get('/api/v1/billing/packages').set(as(guest)).expect(200)).body as PackageOfferDto[];
    expect(offers.map((offer) => [offer.slug, offer.trialDays])).toEqual(expect.arrayContaining([['basic', 0], ['plus', 7]]));
    const list = (await request(t.app).get('/api/v1/operator/channels').set(as(guest)).expect(200)).body as OperatorChannelListDto;
    expect(list.channels.find((c) => c.id === news.id)).toMatchObject({ locked: true, packages: expect.arrayContaining([{ slug: 'basic', name: 'Basic' }]) });
    expect(list.channels.find((c) => c.id === fast.id)).toMatchObject({ locked: false });
    expect((await request(t.app).post('/api/v1/billing/checkout').set(as(guest)).send({ packageId: basic.id }).expect(403)).body.error.code).toBe('ACCOUNT_REQUIRED');
  });

  // --- gate: no entitlement, no stream --------------------------------------------------------------

  it('authorizes operator playback only through playback sessions, with a registered device', async () => {
    alice = await register('alice@example.com');
    // The plain playback endpoint no longer plays operator content.
    expect((await request(t.app).post('/api/v1/playback').set(as(alice)).send({ content: { type: 'operator', channelId: news.id }, secureContext: false }).expect(403)).body.error.code).toBe('PLAYBACK_SESSION_REQUIRED');
    // A made-up device id is not a device.
    expect((await request(t.app).post('/api/v1/operator/playback/sessions').set(as(alice)).send({ channelId: fast.id, deviceId: newEntityId(), secureContext: false }).expect(403)).body.error.code).toBe('DEVICE_REQUIRED');
    await request(t.app).post('/api/v1/devices').set(as(alice)).send({ key: 'too-short', name: 'Laptop', platform: 'web' }).expect(400);
    const laptop = await addDevice(alice, 'Laptop');
    // Same key again = same device (a reinstalled tab does not eat a slot).
    const key = newEntityId() + newEntityId();
    const first = (await request(t.app).post('/api/v1/devices').set(as(alice)).send({ key, name: 'Phone', platform: 'web' }).expect(201)).body as DeviceDto;
    const again = (await request(t.app).post('/api/v1/devices').set(as(alice)).send({ key, name: 'Phone', platform: 'web' }).expect(201)).body as DeviceDto;
    expect(again.id).toBe(first.id);
    await request(t.app).delete(`/api/v1/devices/${first.id}`).set(as(alice)).expect(204);
    expect((await account(alice)).devices.map((d) => d.id)).toEqual([laptop.id]);

    // No subscription: the premium channel is refused; the FAST channel plays.
    expect((await start(alice, news.id).expect(403)).body.error).toMatchObject({ code: 'NOT_ENTITLED', details: { reason: 'no_subscription' } });
    const free = (await start(alice, fast.id).expect(201)).body as PlaybackSessionDto;
    expect(free).toMatchObject({ heartbeatIntervalSeconds: 30, policy: { access: 'fast', maxStreams: 1 } });
    expect(free.plan.candidates.every((c) => c.via === 'proxy')).toBe(true);
    expect(await proxy(free)).toBe(200);
    await stop(alice, free.playbackSessionId).expect(204);
    expect(await proxy(free)).toBe(403);
  });

  it('never grants access because the browser came back: only a verified payment counts (Gate)', async () => {
    const started = (await request(t.app).post('/api/v1/billing/checkout').set(as(alice)).send({ packageId: basic.id }).expect(201)).body as CheckoutStartedDto;
    // The "success" page without paying: the server asks the processor and finds nothing paid.
    const status = (await request(t.app).get(`/api/v1/billing/checkout/${started.checkoutId}`).set(as(alice)).expect(200)).body as CheckoutStatusDto;
    expect(status).toMatchObject({ status: 'open', subscription: null });
    expect((await start(alice, news.id).expect(403)).body.error.details.reason).toBe('no_subscription');
    // Somebody else's checkout id is not found.
    bob = await register('bob@example.com');
    await request(t.app).get(`/api/v1/billing/checkout/${started.checkoutId}`).set(as(bob)).expect(404);
    // Abandoning on the hosted page sends the browser back to the plans.
    const ref = new URL(started.redirectUrl).pathname.split('/').pop()!;
    expect((await request(t.app).post(`/billing/fake-checkout/${ref}/cancel`).type('form').send({}).expect(303)).headers.location).toContain('/plans?canceled=1');
  });

  it('rejects forged and unknown webhooks; replays are recorded once (Gate)', async () => {
    const forged = { id: 'evt_forged', type: 'checkout.completed', occurredAt: new Date().toISOString(), checkoutRef: null, subscription: { ref: 'fsub_x' }, invoice: null };
    expect((await request(t.app).post('/api/v1/billing/webhooks/fake').set('content-type', 'application/json').set('x-fake-signature', 'deadbeef').send(JSON.stringify(forged)).expect(400)).body.error.code).toBe('FORBIDDEN');
    await request(t.app).post('/api/v1/billing/webhooks/fake').set('content-type', 'application/json').send(JSON.stringify(forged)).expect(400);
    await request(t.app).post('/api/v1/billing/webhooks/stripe').set('content-type', 'application/json').send('{}').expect(404);
    const events = (await request(admin).get('/admin/v1/billing/payment-events').set(ops()).expect(200)).body as PaymentEventDto[];
    expect(events.map((event) => event.eventId)).not.toContain('evt_forged');
  });

  it('activates the subscription from the processor’s webhook; a replayed webhook changes nothing', async () => {
    const status = await subscribe(alice, basic.id);
    expect(status.subscription).toMatchObject({ status: 'active', package: { slug: 'basic' }, cancelAtPeriodEnd: false });
    expect(Date.parse(status.subscription!.accessUntil!)).toBeGreaterThan(Date.now() + 27 * DAY);
    const replay = fake.signed(fake.lastEvent!);
    const replayed = await request(t.app).post('/api/v1/billing/webhooks/fake').set(replay.headers).send(replay.body.toString('utf8'));
    expect(replayed.body).toMatchObject({ result: 'duplicate' });
    const summary = await account(alice);
    expect(summary.invoices).toHaveLength(1);
    expect(summary.entitlements).toEqual([expect.objectContaining({ kind: 'subscription', active: true, package: expect.objectContaining({ slug: 'basic' }) })]);
    expect(summary.limits).toEqual({ maxDevices: 2, maxStreams: 1 });
    // A second purchase while subscribed is refused.
    expect((await request(t.app).post('/api/v1/billing/checkout').set(as(alice)).send({ packageId: plus.id }).expect(409)).body.error.code).toBe('ALREADY_SUBSCRIBED');

    const list = (await request(t.app).get('/api/v1/operator/channels').set(as(alice)).expect(200)).body as OperatorChannelListDto;
    expect(list.channels.find((c) => c.id === news.id)?.locked).toBe(false);
    const session = (await start(alice, news.id).expect(201)).body as PlaybackSessionDto;
    expect(session.policy).toEqual({ access: 'package', maxStreams: 1, activeStreams: 1 });
    expect(await proxy(session)).toBe(200);
    expect((await heartbeat(alice, session.playbackSessionId).expect(200)).body.expiresAt).toBeTruthy();
    await stop(alice, session.playbackSessionId).expect(204);
  });

  // --- bypass attempts ------------------------------------------------------------------------------

  it('limits simultaneous streams across devices; "stop the other one" frees the slot (Gate)', async () => {
    const tv = await addDevice(alice, 'Living room');
    const watching = (await start(alice, news.id).expect(201)).body as PlaybackSessionDto;
    const refused = (await start(alice, news.id, tv.id).expect(409)).body.error;
    expect(refused.code).toBe('CONCURRENCY_LIMIT');
    expect(refused.details as ConcurrencyLimitDetails).toMatchObject({ limit: 1, playing: [expect.objectContaining({ playbackSessionId: watching.playbackSessionId, deviceName: 'Laptop', channelId: news.id })] });
    // Racing starts from the second device cannot slip past the limit either.
    const racing = await Promise.all([start(alice, fast.id, tv.id), start(alice, news.id, tv.id), start(alice, fast.id, tv.id)]);
    expect(racing.every((response) => response.status === 409)).toBe(true);

    // The plan allows 2 devices: a third is refused.
    const third = await request(t.app).post('/api/v1/devices').set(as(alice)).send({ key: newEntityId() + newEntityId(), name: 'Tablet', platform: 'web' }).expect(409);
    expect(third.body.error).toMatchObject({ code: 'DEVICE_LIMIT', details: { limit: 2 } });

    // Stop the laptop's viewing from the TV: its link dies, the TV gets the slot.
    await stop(alice, watching.playbackSessionId).expect(204);
    expect(await proxy(watching)).toBe(403);
    await heartbeat(alice, watching.playbackSessionId).expect(404);
    const onTv = (await start(alice, news.id, tv.id).expect(201)).body as PlaybackSessionDto;
    expect(await proxy(onTv)).toBe(200);
    // Another account cannot touch it.
    await stop(bob, onTv.playbackSessionId).expect(404);
    await heartbeat(bob, onTv.playbackSessionId).expect(404);
    await stop(alice, onTv.playbackSessionId).expect(204);
  });

  it('re-checks the country on every heartbeat: travelling out of the licensed market ends the viewing (Gate)', async () => {
    expect((await start(alice, news.id, undefined, { 'cf-ipcountry': 'US' }).expect(403)).body.error.details.reason).toBe('territory');
    const session = (await start(alice, news.id).expect(201)).body as PlaybackSessionDto;
    expect((await heartbeat(alice, session.playbackSessionId, { 'cf-ipcountry': 'US' }).expect(403)).body.error.details.reason).toBe('territory');
    expect(await proxy(session)).toBe(403);
    await heartbeat(alice, session.playbackSessionId).expect(404);
    // The slot was released with it.
    const next = (await start(alice, news.id).expect(201)).body as PlaybackSessionDto;
    await stop(alice, next.playbackSessionId).expect(204);
  });

  it('stops viewings at once when the rights grant is revoked (Gate)', async () => {
    const session = (await start(alice, news.id).expect(201)).body as PlaybackSessionDto;
    expect(await proxy(session)).toBe(200);
    await request(admin).post(`/admin/v1/grants/${newsGrant.id}/revoke`).set(ops()).expect(200);
    expect(await proxy(session)).toBe(403);
    await heartbeat(alice, session.playbackSessionId).expect(404);
    expect((await start(alice, news.id).expect(403)).body.error.details.reason).toBe('not_licensed');
    newsGrant = (await request(admin).post(`/admin/v1/channels/${news.id}/grants`).set(ops()).send({ deviceClasses: ['web'], startAt: new Date(Date.now() - 60_000).toISOString(), contractRef: 'LIC-2026-008b', territory: 'GE', businessModels: ['subscription'] }).expect(201)).body as RightsGrantDto;
  });

  it('removing a device ends its viewing and the device can no longer start one (Gate)', async () => {
    const tv = alice.devices[1]!;
    const session = (await start(alice, news.id, tv.id).expect(201)).body as PlaybackSessionDto;
    await request(t.app).delete(`/api/v1/devices/${tv.id}`).set(as(alice)).expect(204);
    expect(await proxy(session)).toBe(403);
    expect((await start(alice, news.id, tv.id).expect(403)).body.error.code).toBe('DEVICE_REQUIRED');
    await request(t.app).delete(`/api/v1/devices/${tv.id}`).set(as(bob)).expect(404);
    expect((await account(alice)).playing).toEqual([]);
  });

  // --- lifecycle: trial, cancel, resume, renew, refund ----------------------------------------------

  it('gives one trial per account; cancel keeps access to the period end, resume undoes it', async () => {
    await addDevice(bob, 'Bob laptop');
    const status = await subscribe(bob, plus.id);
    expect(status.subscription).toMatchObject({ status: 'trialing', package: { slug: 'plus' } });
    expect(Date.parse(status.subscription!.trialEndsAt!)).toBeGreaterThan(Date.now() + 6 * DAY);
    expect((await start(bob, news.id).expect(201)).body.policy).toMatchObject({ access: 'package', maxStreams: 2 });

    const canceled = (await request(t.app).post('/api/v1/billing/subscription/cancel').set(as(bob)).expect(200)).body as SubscriptionDto;
    expect(canceled).toMatchObject({ status: 'trialing', cancelAtPeriodEnd: true });
    expect((await account(bob)).playing).toHaveLength(1); // still watching
    const resumed = (await request(t.app).post('/api/v1/billing/subscription/resume').set(as(bob)).expect(200)).body as SubscriptionDto;
    expect(resumed.cancelAtPeriodEnd).toBe(false);
    // The processor's own webhooks for both arrive later and agree.
    await waitFor(async () => ((await request(admin).get('/admin/v1/billing/payment-events').set(ops())).body as PaymentEventDto[]).filter((e) => e.type === 'subscription.updated').length >= 2 || null);
    expect((await live(bob))?.cancelAtPeriodEnd).toBe(false);
    // Bob's trial is used up.
    const offers = (await request(t.app).get('/api/v1/billing/packages').set(as(bob)).expect(200)).body as PackageOfferDto[];
    expect(offers.find((o) => o.slug === 'plus')?.trialDays).toBe(0);
  });

  it('renews from the trial; a refund cancels the subscription and ends its viewings now', async () => {
    fake.renew(fake.subscriptionOf((await subscriptionRefOf(bob)))!);
    await waitFor(async () => ((await live(bob))?.status === 'active' ? true : null));
    expect((await account(bob)).invoices).toHaveLength(1);

    const watching = ((await account(bob)).playing)[0]!;
    const session = { playbackSessionId: watching.playbackSessionId } as PlaybackSessionDto;
    await request(admin).post(`/admin/v1/users/${bob.userId}/subscription/refund`).set(ops()).expect(202);
    await waitFor(async () => ((await live(bob)) === null ? true : null));
    const summary = await account(bob);
    expect(summary.invoices[0]?.status).toBe('refunded');
    expect(summary.entitlements.every((e) => !e.active)).toBe(true);
    await waitFor(async () => ((await account(bob)).playing.length === 0 ? true : null));
    await heartbeat(bob, session.playbackSessionId).expect(404);
    expect((await start(bob, news.id).expect(403)).body.error.details.reason).toBe('no_subscription');
    const audit = (await request(admin).get(`/admin/v1/audit?action=subscription.refund_requested`).set(ops()).expect(200)).body as AuditPageDto;
    expect(audit.items).toHaveLength(1);
  }, 30_000);

  // The checkout ref of the viewer's latest checkout (the fake processor keys subscriptions by it).
  async function subscriptionRefOf(who: Account): Promise<string> {
    const row = await t.db.selectFrom('checkouts').select('processor_ref').where('user_id', '=', who.userId).where('status', '=', 'completed').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    return row.processor_ref!;
  }

  it('a payment collected for a subscription that has ended is refunded automatically', async () => {
    const ref = fake.subscriptionOf(await subscriptionRefOf(bob))!;
    fake.renew(ref); // the processor charges a canceled subscription (a retry racing the cancel)
    await waitFor(async () => ((await fake.fetchSubscription(ref))?.latestInvoice?.refundedAt ? true : null));
    expect(await live(bob)).toBeNull();
    const events = (await request(admin).get('/admin/v1/billing/payment-events').set(ops()).expect(200)).body as PaymentEventDto[];
    expect(events.find((e) => e.type === 'invoice.paid' && e.outcome?.startsWith('voided'))).toBeTruthy();
  }, 30_000);

  it('paying two open checkouts keeps one subscription: the second is refunded and canceled at the processor', async () => {
    const carol = await register('carol@example.com');
    const first = (await request(t.app).post('/api/v1/billing/checkout').set(as(carol)).send({ packageId: basic.id }).expect(201)).body as CheckoutStartedDto;
    const second = (await request(t.app).post('/api/v1/billing/checkout').set(as(carol)).send({ packageId: basic.id }).expect(201)).body as CheckoutStartedDto;
    const refOf = (started: CheckoutStartedDto) => new URL(started.redirectUrl).pathname.split('/').pop()!;
    fake.pay(refOf(first));
    await waitFor(async () => ((await live(carol))?.status === 'active' ? true : null));
    fake.pay(refOf(second));
    const duplicate = fake.subscriptionOf(refOf(second))!;
    await waitFor(async () => {
      const remote = await fake.fetchSubscription(duplicate);
      return remote?.status === 'canceled' && remote.latestInvoice?.refundedAt ? true : null;
    });
    expect((await request(t.app).get(`/api/v1/billing/checkout/${second.checkoutId}`).set(as(carol)).expect(200)).body).toMatchObject({ status: 'expired', subscription: null });
    const summary = await account(carol);
    expect(summary.subscription?.id).toBe(((await request(t.app).get(`/api/v1/billing/checkout/${first.checkoutId}`).set(as(carol))).body as CheckoutStatusDto).subscription?.id);
    expect(summary.invoices).toHaveLength(1);
  }, 30_000);

  it('retiring a package stops selling it but keeps serving those who have it', async () => {
    const carol = { token: ((await request(t.app).post('/api/v1/auth/login').send({ email: 'carol@example.com', password: 'correct-horse-battery-9' }).expect(200)).body as AuthSessionDto).token, userId: '', devices: [] as DeviceDto[] };
    await addDevice(carol, 'Carol laptop');
    await request(admin).patch(`/admin/v1/packages/${basic.id}`).set(ops()).send({ status: 'retired' }).expect(200);
    const offers = (await request(t.app).get('/api/v1/billing/packages').set(as(carol)).expect(200)).body as PackageOfferDto[];
    expect(offers.map((o) => o.slug)).not.toContain('basic');
    const session = (await start(carol, news.id).expect(201)).body as PlaybackSessionDto;
    expect(session.policy.access).toBe('package');
    await stop(carol, session.playbackSessionId).expect(204);
    await request(admin).patch(`/admin/v1/packages/${basic.id}`).set(ops()).send({ status: 'active' }).expect(200);
  });

  it('removing a channel from a package stops the viewings it allowed', async () => {
    const carol = { token: ((await request(t.app).post('/api/v1/auth/login').send({ email: 'carol@example.com', password: 'correct-horse-battery-9' }).expect(200)).body as AuthSessionDto).token, userId: '', devices: [] as DeviceDto[] };
    await addDevice(carol, 'Carol laptop');
    const session = (await start(carol, news.id).expect(201)).body as PlaybackSessionDto;
    await request(admin).patch(`/admin/v1/packages/${basic.id}`).set(ops()).send({ channelIds: [] }).expect(200);
    expect(await proxy(session)).toBe(403);
    expect((await start(carol, news.id).expect(403)).body.error.details.reason).toBe('not_in_package');
    await request(admin).patch(`/admin/v1/packages/${basic.id}`).set(ops()).send({ channelIds: [news.id] }).expect(200);
  });

  // --- console: comp access and blocks --------------------------------------------------------------

  it('comp entitlements give access without payment; revoking one ends its viewings at once', async () => {
    const comp = (await request(admin).post(`/admin/v1/users/${bob.userId}/entitlements`).set(ops()).send({ packageId: basic.id, note: 'Hotel pilot' }).expect(201)).body as EntitlementDto;
    expect(comp).toMatchObject({ kind: 'comp', active: true, endsAt: null });
    const session = (await start(bob, news.id).expect(201)).body as PlaybackSessionDto;
    expect(session.policy.access).toBe('package');
    // A subscription's entitlement cannot be revoked directly.
    const billing = (await request(admin).get(`/admin/v1/users/${alice.userId}/billing`).set(ops()).expect(200)).body as UserBillingDto;
    const subscriptionEntitlement = billing.entitlements.find((e) => e.kind === 'subscription')!;
    await request(admin).delete(`/admin/v1/users/${alice.userId}/entitlements/${subscriptionEntitlement.id}`).set(ops()).expect(409);

    await request(admin).delete(`/admin/v1/users/${bob.userId}/entitlements/${comp.id}`).set(ops()).expect(204);
    expect(await proxy(session)).toBe(403);
    expect((await start(bob, news.id).expect(403)).body.error.details.reason).toBe('no_subscription');
  });

  it('blocking an account ends its viewings and stops purchases', async () => {
    const session = (await start(alice, news.id).expect(201)).body as PlaybackSessionDto;
    const blocked = (await request(admin).post(`/admin/v1/users/${alice.userId}/block`).set(ops()).send({ blocked: true, reason: 'chargeback' }).expect(200)).body as UserBillingDto;
    expect(blocked).toMatchObject({ blocked: true, blockedReason: 'chargeback', playing: [] });
    expect(await proxy(session)).toBe(403);
    expect((await start(alice, news.id).expect(403)).body.error.details.reason).toBe('account_blocked');
    expect((await start(alice, fast.id).expect(403)).body.error.details.reason).toBe('account_blocked');
    await request(admin).post(`/admin/v1/users/${alice.userId}/block`).set(ops()).send({ blocked: false }).expect(200);
    const again = (await start(alice, news.id).expect(201)).body as PlaybackSessionDto;
    await stop(alice, again.playbackSessionId).expect(204);
  });

  // --- time: dunning and expiry (runs last: it moves the clock) -------------------------------------

  it('a failed renewal goes past_due → grace (still watching) → expired: no stream after expiry (Gate)', async () => {
    const ref = fake.subscriptionOf(await subscriptionRefOf(alice))!;
    const paidUntil = Date.parse((await live(alice))!.currentPeriodEnd!);
    offsetMs = paidUntil - Date.now() + 60_000; // the period is over
    fake.renew(ref, { fail: true });
    await waitFor(async () => ((await live(alice))?.status === 'past_due' ? true : null));
    const session = (await start(alice, news.id).expect(201)).body as PlaybackSessionDto;

    offsetMs = paidUntil - Date.now() + 3 * DAY + 120_000;
    await t.container.commerce.billing.runClock();
    expect((await live(alice))?.status).toBe('grace');
    // Days passed: that viewing timed out long ago (no heartbeats) and housekeeping closed it;
    // a new one still works in grace.
    expect(await t.container.commerce.authorization.expireStale()).toBe(1);
    await heartbeat(alice, session.playbackSessionId).expect(404);
    const accessUntil = Date.parse((await live(alice))!.accessUntil!);
    expect(accessUntil).toBeGreaterThan(paidUntil + 6 * DAY);
    offsetMs = accessUntil - Date.now() - 20_000; // the last seconds of grace
    const inGrace = (await start(alice, news.id).expect(201)).body as PlaybackSessionDto;

    offsetMs = accessUntil - Date.now() + 20_000; // grace is over; the viewing's lease is still valid
    // Even before the clock job runs, the entitlement has already ended (ends_at = access until).
    expect((await heartbeat(alice, inGrace.playbackSessionId).expect(403)).body.error.details.reason).toBe('no_subscription');
    expect(await proxy(inGrace)).toBe(403);
    await t.container.commerce.billing.runClock();
    expect(await live(alice)).toBeNull();
    // (Directly: the console session idled out while the clock jumped a week.)
    const history = await t.container.admin.commerce.userBilling(alice.userId);
    expect(history.subscriptions[0]?.status).toBe('expired');
    // …and the processor is told to stop charging (outbox).
    await waitFor(async () => ((await fake.fetchSubscription(ref))?.status === 'canceled' ? true : null));
    expect((await start(alice, news.id).expect(403)).body.error.details.reason).toBe('no_subscription');
  }, 30_000);
});

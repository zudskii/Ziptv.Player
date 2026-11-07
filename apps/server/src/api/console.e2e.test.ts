import type {
  AdminUserPageDto,
  AuditPageDto,
  AuthSessionDto,
  ChangeRequestDto,
  ChangeRequestedDto,
  ChangeRequestPageDto,
  DuplicateGroupDto,
  FinanceSummaryDto,
  MasterChannelDetailDto,
  MasterChannelPageDto,
  PackageDetailDto,
  PackageDto,
  PartnerReportDto,
  ProviderDto,
  ProviderReportDto,
  SecurityOverviewDto,
  SupportNoteDto,
  SystemOverviewDto,
  EpgCoverageDto,
  OperatorGuideChannelDto,
  OperatorGuideDto,
  OperatorNowNextDto,
  SessionDto, PromoCodeDto } from '@ziptv/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newEntityId } from '../domain/shared/ids.js';
import { createLogger } from '../infrastructure/logger.js';
import { staffSession, type StaffSession } from '../test/console.js';
import { startOrigin, startTestApp, TEST_DATABASE_URL, waitFor, type FakeOrigin, type TestApp } from '../test/harness.js';
import { createAdminApp } from './admin/admin-app.js';

/**
 * Operator console, Phase 9: four-eyes control of prices, packages and rights (9.6), and the
 * console read models behind every screen.
 */
describe.skipIf(!TEST_DATABASE_URL)('Operator console (Phase 9)', () => {
  let t: TestApp;
  let admin: Express;
  let root: StaffSession;
  let finance: StaffSession;
  let finance2: StaffSession;
  let content: StaffSession;
  let content2: StaffSession;
  let support: StaffSession;
  let viewOnly: StaffSession;
  let channel: MasterChannelDetailDto;

  beforeAll(async () => {
    t = await startTestApp({ JOBS_ENABLED: 'true', PROBES_ENABLED: 'false' });
    t.container.jobs.start();
    admin = createAdminApp({ config: t.config, logger: createLogger({ log: { level: process.env.TEST_LOG_LEVEL ?? 'silent' }, env: 'test' }), container: t.container });
    root = await staffSession(t, admin, 'root@ops.example', 'SUPER_ADMIN');
    finance = await staffSession(t, admin, 'finance@ops.example', 'FINANCE');
    finance2 = await staffSession(t, admin, 'finance2@ops.example', 'FINANCE');
    content = await staffSession(t, admin, 'content@ops.example', 'CONTENT_MANAGER');
    content2 = await staffSession(t, admin, 'content2@ops.example', 'CONTENT_MANAGER');
    support = await staffSession(t, admin, 'support@ops.example', 'SUPPORT_AGENT');
    viewOnly = await staffSession(t, admin, 'view@ops.example', 'VIEW_ONLY');
    channel = (await request(admin).post('/admin/v1/channels').set(content.headers).send({ name: 'Rustavi Live', originCountry: 'GE' }).expect(201)).body as MasterChannelDetailDto;
  });
  afterAll(async () => t?.close());

  const decide = (who: StaffSession, id: string, decision: 'approve' | 'reject' | 'withdraw' | 'review', note?: string) => request(admin).post(`/admin/v1/change-requests/${id}/${decision}`).set(who.headers).send(note ? { note } : {});
  const packages = async () => (await request(admin).get('/admin/v1/packages').set(finance.headers).expect(200)).body as PackageDto[];
  let basic: PackageDetailDto;

  describe('four-eyes (9.6)', () => {
    it('a new package waits for a second finance member; the requester cannot approve it', async () => {
      const requested = (await request(admin).post('/admin/v1/packages').set(finance.headers).send({ name: 'Basic', priceMinor: 999, currency: 'GEL', billingPeriod: 'month', maxDevices: 3, maxStreams: 1 }).expect(202)).body as ChangeRequestedDto;
      const cr = requested.changeRequest;
      expect(cr).toMatchObject({ kind: 'package.create', mode: 'approval', status: 'pending', canDecide: false, canWithdraw: true, requestedBy: { email: 'finance@ops.example' } });
      expect(cr.summary).toMatch(/New package “Basic” \(basic, subscription\) — 9\.99 GEL\/month/);
      expect(await packages()).toEqual([]);

      expect((await decide(finance, cr.id, 'approve').expect(403)).body.error.message).toMatch(/second person/);
      // Other roles: no billing permission → the request does not exist for them.
      await decide(content, cr.id, 'approve').expect(404);
      await request(admin).get(`/admin/v1/change-requests/${cr.id}`).set(support.headers).expect(404);
      // VIEW_ONLY sees it, but cannot decide.
      expect(((await request(admin).get(`/admin/v1/change-requests/${cr.id}`).set(viewOnly.headers).expect(200)).body as ChangeRequestDto).canDecide).toBe(false);
      await decide(viewOnly, cr.id, 'approve').expect(403);

      const open = (await request(admin).get('/admin/v1/change-requests?status=open').set(finance2.headers).expect(200)).body as ChangeRequestPageDto;
      expect(open).toMatchObject({ open: 1, items: [expect.objectContaining({ id: cr.id, canDecide: true, canWithdraw: false })] });

      const approved = (await decide(finance2, cr.id, 'approve', 'Matches the price list').expect(200)).body as ChangeRequestDto;
      expect(approved).toMatchObject({ status: 'applied', decidedBy: { email: 'finance2@ops.example' }, decisionNote: 'Matches the price list' });
      const created = (await packages()).find((pkg) => pkg.slug === 'basic')!;
      expect(created).toMatchObject({ status: 'draft', priceMinor: 999 });
      basic = (await request(admin).get(`/admin/v1/packages/${created.id}`).set(finance.headers).expect(200)).body as PackageDetailDto;
      await decide(finance2, cr.id, 'approve').expect(409);

      const audit = (await request(admin).get('/admin/v1/audit?limit=20').set(root.headers).expect(200)).body as AuditPageDto;
      const actions = audit.items.map((item) => item.action);
      expect(actions).toEqual(expect.arrayContaining(['change.requested', 'change.approved', 'package.created']));
      const createdEntry = audit.items.find((item) => item.action === 'package.created')!;
      expect(createdEntry).toMatchObject({ actorEmail: 'finance2@ops.example', details: expect.objectContaining({ changeRequest: cr.id }) });
    });

    it('price changes: one pending change per package; reject needs a reason; withdraw is the requester’s', async () => {
      const first = ((await request(admin).patch(`/admin/v1/packages/${basic.id}`).set(finance.headers).send({ priceMinor: 1299, status: 'active', channelIds: [channel.id] }).expect(202)).body as ChangeRequestedDto).changeRequest;
      expect(first.summary).toBe('Basic: price 9.99 GEL → 12.99 GEL; status draft → active; channels 0 → 1 (+ Rustavi Live)');
      expect((await request(admin).patch(`/admin/v1/packages/${basic.id}`).set(finance2.headers).send({ priceMinor: 1 }).expect(409)).body.error.message).toMatch(/already waiting/);

      await decide(finance2, first.id, 'reject').expect(400);
      expect((await decide(finance2, first.id, 'reject', 'Wrong price').expect(200)).body).toMatchObject({ status: 'rejected', decisionNote: 'Wrong price' });
      expect(((await request(admin).get(`/admin/v1/packages/${basic.id}`).set(finance.headers)).body as PackageDetailDto).priceMinor).toBe(999);

      const second = ((await request(admin).patch(`/admin/v1/packages/${basic.id}`).set(finance.headers).send({ priceMinor: 1099 }).expect(202)).body as ChangeRequestedDto).changeRequest;
      await decide(finance2, second.id, 'withdraw').expect(403);
      expect((await decide(finance, second.id, 'withdraw').expect(200)).body.status).toBe('withdrawn');

      const third = ((await request(admin).patch(`/admin/v1/packages/${basic.id}`).set(finance.headers).send({ priceMinor: 1199, status: 'active', channelIds: [channel.id] }).expect(202)).body as ChangeRequestedDto).changeRequest;
      await decide(finance2, third.id, 'approve').expect(200);
      expect((await request(admin).get(`/admin/v1/packages/${basic.id}`).set(finance.headers).expect(200)).body).toMatchObject({ priceMinor: 1199, status: 'active', channelIds: [channel.id] });
    });

    it('an approval of a request whose package changed meanwhile fails visibly and changes nothing', async () => {
      const cr = ((await request(admin).patch(`/admin/v1/packages/${basic.id}`).set(finance.headers).send({ maxStreams: 2 }).expect(202)).body as ChangeRequestedDto).changeRequest;
      await t.db.updateTable('packages').set({ description: 'edited behind the console’s back' }).where('id', '=', basic.id).execute();
      const failed = (await decide(finance2, cr.id, 'approve').expect(200)).body as ChangeRequestDto;
      expect(failed).toMatchObject({ status: 'failed', error: expect.stringMatching(/changed after this request/) });
      expect(((await request(admin).get(`/admin/v1/packages/${basic.id}`).set(finance.headers)).body as PackageDetailDto).maxStreams).toBe(1);
    });

    it('two approved creates with the same slug: the second fails instead of overwriting', async () => {
      const a = ((await request(admin).post('/admin/v1/packages').set(finance.headers).send({ name: 'Sport', priceMinor: 500, currency: 'GEL', billingPeriod: 'month', maxDevices: 2, maxStreams: 1 }).expect(202)).body as ChangeRequestedDto).changeRequest;
      const b = ((await request(admin).post('/admin/v1/packages').set(finance2.headers).send({ name: 'Sport', priceMinor: 700, currency: 'GEL', billingPeriod: 'month', maxDevices: 2, maxStreams: 1 }).expect(202)).body as ChangeRequestedDto).changeRequest;
      await decide(finance2, a.id, 'approve').expect(200);
      expect((await decide(finance, b.id, 'approve').expect(200)).body).toMatchObject({ status: 'failed' });
      expect((await packages()).filter((pkg) => pkg.slug === 'sport').map((pkg) => pkg.priceMinor)).toEqual([500]);
    });

    it('a promo code (a discount on revenue) waits for a second finance member; stopping one acts at once', async () => {
      const cr = ((await request(admin).post('/admin/v1/promo-codes').set(finance.headers).send({ code: 'launch', kind: 'percent', value: 30, maxRedemptions: 500 }).expect(202)).body as ChangeRequestedDto).changeRequest;
      expect(cr).toMatchObject({ kind: 'promo.create', status: 'pending' });
      expect(cr.summary).toMatch(/^Promo code LAUNCH: 30 % off the first payment, every plan, up to 500 uses/);
      expect((await request(admin).get('/admin/v1/promo-codes').set(finance.headers).expect(200)).body).toEqual([]);
      await decide(finance, cr.id, 'approve').expect(403);
      await request(admin).post('/admin/v1/promo-codes').set(content.headers).send({ code: 'x-content', kind: 'percent', value: 10 }).expect(403);
      await decide(finance2, cr.id, 'approve').expect(200);
      const [promo] = (await request(admin).get('/admin/v1/promo-codes').set(finance.headers).expect(200)).body as PromoCodeDto[];
      expect(promo).toMatchObject({ code: 'LAUNCH', active: true, value: 30 });
      expect((await request(admin).patch(`/admin/v1/promo-codes/${promo!.id}`).set(finance.headers).send({ active: false }).expect(200)).body).toMatchObject({ active: false });
    });

    it('a new rights grant waits for a second content manager; a revocation applies at once and is reviewed', async () => {
      const cr = ((await request(admin).post(`/admin/v1/channels/${channel.id}/grants`).set(content.headers).send({ territory: 'GE', deviceClasses: ['web'], businessModels: ['subscription'], startAt: new Date().toISOString(), contractRef: 'LIC-9' }).expect(202)).body as ChangeRequestedDto).changeRequest;
      expect(cr.summary).toMatch(/^Rights for “Rustavi Live”: GE · web · subscription · .* · contract LIC-9$/);
      expect(((await request(admin).get(`/admin/v1/channels/${channel.id}`).set(content.headers)).body as MasterChannelDetailDto).grants).toEqual([]);
      // Finance sees rights (rights:read) but cannot decide on them.
      expect((await decide(finance, cr.id, 'approve').expect(403)).body.error.message).toMatch(/role cannot decide/);
      await decide(content, cr.id, 'approve').expect(403);
      await decide(content2, cr.id, 'approve').expect(200);
      const grants = ((await request(admin).get(`/admin/v1/channels/${channel.id}`).set(content.headers)).body as MasterChannelDetailDto).grants;
      expect(grants).toEqual([expect.objectContaining({ territory: 'GE', status: 'active', contractRef: 'LIC-9' })]);

      await request(admin).post(`/admin/v1/grants/${grants[0]!.id}/revoke`).set(content.headers).expect(200);
      expect(((await request(admin).get(`/admin/v1/channels/${channel.id}`).set(content.headers)).body as MasterChannelDetailDto).grants[0]!.status).toBe('revoked');
      const review = ((await request(admin).get('/admin/v1/change-requests?status=open&kind=rights.revoke').set(content2.headers).expect(200)).body as ChangeRequestPageDto).items[0]!;
      expect(review).toMatchObject({ mode: 'review', status: 'applied', canDecide: true });
      await decide(content, review.id, 'review').expect(403);
      expect((await decide(content2, review.id, 'review', 'Licence ended 31 Oct').expect(200)).body).toMatchObject({ status: 'reviewed' });
      expect(((await request(admin).get('/admin/v1/change-requests?status=open').set(content2.headers).expect(200)).body as ChangeRequestPageDto).open).toBe(0);
    });

    it('a revocation after a grant was requested makes that request stale; a merge cannot carry rights past the approval flow', async () => {
      const dup = (await request(admin).post('/admin/v1/channels').set(content.headers).send({ name: 'Rustavi Live HD', originCountry: 'GE' }).expect(201)).body as MasterChannelDetailDto;
      const grant = (body: object) => request(admin).post(`/admin/v1/channels/${dup.id}/grants`).set(content.headers).send({ territory: 'GE', deviceClasses: ['web'], businessModels: ['subscription'], startAt: new Date().toISOString(), ...body });
      const first = ((await grant({ contractRef: 'LIC-A' }).expect(202)).body as ChangeRequestedDto).changeRequest;
      await decide(content2, first.id, 'approve').expect(200);
      const second = ((await grant({ contractRef: 'LIC-B' }).expect(202)).body as ChangeRequestedDto).changeRequest;
      const active = ((await request(admin).get(`/admin/v1/channels/${dup.id}`).set(content.headers)).body as MasterChannelDetailDto).grants.find((item) => item.contractRef === 'LIC-A')!;

      // Active rights block the merge: they would move to the other channel without a second person.
      expect((await request(admin).post(`/admin/v1/channels/${channel.id}/merge`).set(content.headers).send({ fromChannelId: dup.id }).expect(409)).body.error.message).toMatch(/active rights grants/);

      await request(admin).post(`/admin/v1/grants/${active.id}/revoke`).set(content.headers).expect(200);
      expect((await decide(content2, second.id, 'approve').expect(200)).body).toMatchObject({ status: 'failed', error: expect.stringMatching(/changed after this request/) });
      expect(((await request(admin).get(`/admin/v1/channels/${dup.id}`).set(content.headers)).body as MasterChannelDetailDto).grants.every((item) => item.status === 'revoked')).toBe(true);

      const review = ((await request(admin).get('/admin/v1/change-requests?status=open&kind=rights.revoke').set(content2.headers).expect(200)).body as ChangeRequestPageDto).items[0]!;
      await decide(content2, review.id, 'review', 'Licence A ended').expect(200);
      await request(admin).post(`/admin/v1/channels/${channel.id}/merge`).set(content.headers).send({ fromChannelId: dup.id }).expect(200);
    });
  });

  describe('read models (9.1–9.10)', () => {
    const DAY = 86_400_000;
    const ago = (ms: number) => new Date(Date.now() - ms);
    let providerA: ProviderDto;
    let providerB: ProviderDto;
    const users: string[] = [];

    it('providers carry a contract, SLA target and cost; the report measures availability against it', async () => {
      providerA = (await request(admin).post('/admin/v1/providers').set(content.headers).send({ name: 'Licensor A', type: 'mock', config: { channels: [] } }).expect(201)).body as ProviderDto;
      providerB = (await request(admin).post('/admin/v1/providers').set(content.headers).send({ name: 'Licensor B', type: 'mock', config: { channels: [] } }).expect(201)).body as ProviderDto;
      const updated = (await request(admin)
        .patch(`/admin/v1/providers/${providerA.id}`)
        .set(content.headers)
        .send({ contract: { ref: 'LIC-A-2026', startAt: '2026-01-01T00:00:00Z', endAt: '2027-01-01T00:00:00Z', slaTargetPct: 99.5, monthlyCost: { currency: 'gel', amountMinor: 250000 }, notes: 'Renewal in November' } })
        .expect(200)).body as ProviderDto;
      expect(updated.contract).toEqual({ ref: 'LIC-A-2026', startAt: '2026-01-01T00:00:00.000Z', endAt: '2027-01-01T00:00:00.000Z', slaTargetPct: 99.5, monthlyCost: { currency: 'GEL', amountMinor: 250000 }, notes: 'Renewal in November', minimumGuarantee: null, catchupWeight: 1, catchupFeePerHour: null });
      await request(admin).patch(`/admin/v1/providers/${providerA.id}`).set(content.headers).send({ contract: { startAt: '2027-01-01T00:00:00Z', endAt: '2026-01-01T00:00:00Z' } }).expect(400);
      await request(admin).patch(`/admin/v1/providers/${providerA.id}`).set(finance.headers).send({ contract: { notes: 'x' } }).expect(403);
      const report = (await request(admin).get(`/admin/v1/providers/${providerA.id}/report`).set(content.headers).expect(200)).body as ProviderReportDto;
      expect(report).toMatchObject({ slaTargetPct: 99.5, availabilityPct: null, slaMet: null, feeds: { total: 0 }, openIncidents: 0 });
    });

    it('finance: MRR from what subscribers pay, churn and revenue for the period, per package', async () => {
      for (const n of [1, 2, 3]) {
        const session = (await request(t.app).post('/api/v1/auth/register').send({ email: `viewer${n}@example.com`, password: 'correct-horse-battery-9' }).expect(201)).body as AuthSessionDto;
        users.push(session.user.userId);
      }
      const sub = (user: string, status: string, created: Date, ended: Date | null) => ({ id: newEntityId(), user_id: user, package_id: basic.id, status: status as never, processor: 'fake', processor_ref: `ref-${newEntityId()}`, created_at: created, ended_at: ended, updated_at: created });
      const subs = [sub(users[0]!, 'active', ago(10 * DAY), null), sub(users[1]!, 'active', ago(3 * DAY), null), sub(users[2]!, 'canceled', ago(40 * DAY), ago(5 * DAY))];
      await t.db.insertInto('subscriptions').values(subs).execute();
      const invoice = (s: (typeof subs)[number], amount: number, paid: Date, days: number) => ({ id: newEntityId(), user_id: s.user_id, subscription_id: s.id, processor: 'fake', processor_ref: `inv-${newEntityId()}`, amount_minor: amount, currency: 'GEL', status: 'paid' as const, period_start: paid, period_end: new Date(paid.getTime() + days * DAY), paid_at: paid, refunded_at: null });
      await t.db.insertInto('invoices').values([invoice(subs[0]!, 1199, ago(10 * DAY), 30), invoice(subs[1]!, 12000, ago(3 * DAY), 365), invoice(subs[2]!, 999, ago(40 * DAY), 30)]).execute();

      const summary = (await request(admin).get('/admin/v1/finance/summary').set(finance.headers).expect(200)).body as FinanceSummaryDto;
      expect(summary.mrr).toEqual([{ currency: 'GEL', amountMinor: 2199 }]); // 11.99 + 120.00 / 12
      expect(summary.subscriptions).toMatchObject({ active: 2, trialing: 0 });
      expect(summary.period).toMatchObject({ newSubscriptions: 2, churned: 1, activeAtStart: 1, churnRate: 1, revenue: [{ currency: 'GEL', amountMinor: 13199 }], refunds: [], net: [{ currency: 'GEL', amountMinor: 13199 }] });
      expect(summary.packages.find((pkg) => pkg.id === basic.id)).toMatchObject({ activeSubscriptions: 2, mrr: [{ currency: 'GEL', amountMinor: 2199 }], net: [{ currency: 'GEL', amountMinor: 13199 }] });
      expect(summary.months).toHaveLength(12);
      await request(admin).get('/admin/v1/finance/summary').set(content.headers).expect(403);
      await request(admin).get('/admin/v1/finance/summary?from=2026-10-01&to=2026-09-01').set(finance.headers).expect(400);
    });

    it('partner report: package revenue split by the minutes watched on each provider’s feeds; CSV export', async () => {
      const device = async (user: string) => {
        const id = newEntityId();
        await t.db.insertInto('devices').values({ id, user_id: user, key_hash: newEntityId(), name: 'Web', platform: 'web' }).execute();
        return id;
      };
      const watched = async (user: string, provider: string, minutes: number) => {
        const started = ago(3 * 3600_000);
        const ended = new Date(started.getTime() + minutes * 60_000);
        await t.db
          .insertInto('playback_sessions')
          .values({ id: newEntityId(), user_id: user, profile_id: null, device_id: await device(user), channel_id: channel.id, access: 'package', package_id: basic.id, country: 'GE', provider_id: provider, started_at: started, last_heartbeat_at: new Date(ended.getTime() - 30_000), expires_at: ended, ended_at: ended, end_reason: 'stopped' })
          .execute();
      };
      await watched(users[0]!, providerA.id, 60);
      await watched(users[1]!, providerB.id, 30);

      const report = (await request(admin).get('/admin/v1/finance/partners').set(finance.headers).expect(200)).body as PartnerReportDto;
      expect(report).toMatchObject({ method: 'watch_minutes', totalMinutes: 90, unattributedRevenue: [] });
      const a = report.partners.find((row) => row.providerId === providerA.id)!;
      const b = report.partners.find((row) => row.providerId === providerB.id)!;
      expect(a).toMatchObject({ minutes: 60, share: 0.6667, revenue: [{ currency: 'GEL', amountMinor: 8799 }], contractRef: 'LIC-A-2026', monthlyCost: { currency: 'GEL', amountMinor: 250000 } });
      expect(b).toMatchObject({ minutes: 30, share: 0.3333, revenue: [{ currency: 'GEL', amountMinor: 4400 }] });

      const csv = await request(admin).get('/admin/v1/finance/partners.csv').set(finance.headers).expect(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text).toContain('provider,contract,minutes,live_minutes,catchup_minutes,share_pct,revenue_GEL,monthly_cost,cost_currency,minimum_guarantee,guarantee_top_up,guarantee_currency,catchup_fees,catchup_fee_currency');
      expect(csv.text).toContain('Licensor A,LIC-A-2026,60,60,0,66.67,87.99,2500.00,GEL,,,,,');
    });

    it('contract terms (17.5): catch-up minutes weighted per contract, a separate catch-up tariff, a minimum guarantee topped up', async () => {
      // B's catch-up counts half in the share and costs 1.20 GEL per hour; A is guaranteed 300 GEL a month.
      await request(admin).patch(`/admin/v1/providers/${providerB.id}`).set(content.headers).send({ contract: { catchupWeight: 0.5, catchupFeePerHour: { currency: 'gel', amountMinor: 120 } } }).expect(200);
      await request(admin).patch(`/admin/v1/providers/${providerB.id}`).set(content.headers).send({ contract: { catchupWeight: 9 } }).expect(400);
      const updated = (await request(admin).patch(`/admin/v1/providers/${providerA.id}`).set(content.headers).send({ contract: { minimumGuarantee: { currency: 'GEL', amountMinor: 30000 } } }).expect(200)).body as ProviderDto;
      expect(updated.contract).toMatchObject({ minimumGuarantee: { currency: 'GEL', amountMinor: 30000 }, catchupWeight: 1, catchupFeePerHour: null });
      const deviceId = newEntityId();
      await t.db.insertInto('devices').values({ id: deviceId, user_id: users[1]!, key_hash: newEntityId(), name: 'TV', platform: 'tv' }).execute();
      const started = ago(2 * 3600_000);
      const ended = new Date(started.getTime() + 60 * 60_000);
      await t.db
        .insertInto('playback_sessions')
        .values({ id: newEntityId(), user_id: users[1]!, profile_id: null, device_id: deviceId, channel_id: channel.id, access: 'package', package_id: basic.id, country: 'GE', provider_id: providerB.id, started_at: started, last_heartbeat_at: new Date(ended.getTime() - 30_000), expires_at: ended, ended_at: ended, end_reason: 'stopped', archive_start: ago(30 * 3600_000), archive_end: ago(29 * 3600_000) })
        .execute();

      const report = (await request(admin).get('/admin/v1/finance/partners').set(finance.headers).expect(200)).body as PartnerReportDto;
      const a = report.partners.find((row) => row.providerId === providerA.id)!;
      const b = report.partners.find((row) => row.providerId === providerB.id)!;
      // Weighted minutes: A 60, B 30 live + 60 × 0.5 catch-up = 60 → an even split of 131.99 GEL.
      expect(b).toMatchObject({ minutes: 90, liveMinutes: 30, catchupMinutes: 60, share: 0.5, catchupFees: { currency: 'GEL', amountMinor: 120 }, minimumGuarantee: null, guaranteeTopUp: null });
      expect(a).toMatchObject({ minutes: 60, liveMinutes: 60, catchupMinutes: 0, share: 0.5, revenue: [{ currency: 'GEL', amountMinor: 6600 }], catchupFees: null });
      // The default 30-day period owes ~98.6 % of the monthly guarantee; the share falls short by the rest.
      expect(a.minimumGuarantee).toEqual({ currency: 'GEL', amountMinor: Math.round(30000 * (30 / 30.4375)) });
      expect(a.guaranteeTopUp).toEqual({ currency: 'GEL', amountMinor: a.minimumGuarantee!.amountMinor - 6600 });
      const csv = await request(admin).get('/admin/v1/finance/partners.csv').set(finance.headers).expect(200);
      expect(csv.text).toContain(`Licensor B,,90,30,60,50.00,66.00,,,,,,1.20,GEL`);
    });

    it('overview: viewing, catalog health and approvals for everyone; revenue only for finance roles', async () => {
      const asFinance = (await request(admin).get('/admin/v1/system/overview').set(finance.headers).expect(200)).body as SystemOverviewDto;
      expect(asFinance.revenue).toMatchObject({ mrr: [{ currency: 'GEL', amountMinor: 2199 }], activeSubscriptions: 2 });
      expect(asFinance.channels.active).toBeGreaterThanOrEqual(1);
      expect(asFinance.viewers).toMatchObject({ playingNow: 0 });
      const asSupport = (await request(admin).get('/admin/v1/system/overview').set(support.headers).expect(200)).body as SystemOverviewDto;
      expect(asSupport.revenue).toBeNull();
    });

    it('channels: list columns (feeds, rights, health) and likely duplicates', async () => {
      await request(admin).post('/admin/v1/channels').set(content.headers).send({ name: 'Rustavi Live HD', originCountry: 'GE' }).expect(201);
      const groups = (await request(admin).get('/admin/v1/channels/duplicates').set(viewOnly.headers).expect(200)).body as DuplicateGroupDto[];
      expect(groups).toEqual([expect.objectContaining({ reason: 'name', key: 'rustavilive', channels: expect.arrayContaining([expect.objectContaining({ name: 'Rustavi Live' }), expect.objectContaining({ name: 'Rustavi Live HD' })]) })]);
      const page = (await request(admin).get('/admin/v1/channels?q=rustavi').set(content.headers).expect(200)).body as MasterChannelPageDto;
      expect(page.items.find((item) => item.id === channel.id)).toMatchObject({ feeds: 0, playableFeeds: 0, activeGrants: 0, health: null });
    });

    it('support notes: written by support, readable by support, kept out of the audit text', async () => {
      const subscriber = ((await request(admin).get('/admin/v1/users?q=viewer1').set(support.headers).expect(200)).body as AdminUserPageDto).items[0]!;
      expect(subscriber).toMatchObject({ subscription: 'active', blocked: false });
      const note = (await request(admin).post(`/admin/v1/users/${subscriber.id}/notes`).set(support.headers).send({ body: 'Called about buffering; router reset fixed it. Phone +995 555 000 000.' }).expect(201)).body as SupportNoteDto;
      expect(note).toMatchObject({ userId: subscriber.id, userEmail: 'viewer1@example.com', author: { email: 'support@ops.example' } });
      expect(((await request(admin).get(`/admin/v1/users/${subscriber.id}/notes`).set(support.headers).expect(200)).body as SupportNoteDto[]).map((n) => n.id)).toEqual([note.id]);
      expect(((await request(admin).get('/admin/v1/support/notes').set(root.headers).expect(200)).body as SupportNoteDto[])[0]!.id).toBe(note.id);
      await request(admin).post(`/admin/v1/users/${subscriber.id}/notes`).set(viewOnly.headers).send({ body: 'x' }).expect(403);
      await request(admin).get(`/admin/v1/users/${subscriber.id}/notes`).set(finance.headers).expect(403);
      await request(admin).post(`/admin/v1/users/${newEntityId()}/notes`).set(support.headers).send({ body: 'nobody' }).expect(404);
      const audit = (await request(admin).get('/admin/v1/audit?action=support.note_added').set(root.headers).expect(200)).body as AuditPageDto;
      expect(audit.items).toHaveLength(1);
      expect(JSON.stringify(audit.items)).not.toContain('router reset');
    });

    it('security: staff MFA and sessions, failed sign-ins from the audit trail', async () => {
      await request(admin).post('/admin/v1/auth/login').send({ email: 'support@ops.example', password: 'wrong-password-123' }).expect(401);
      // The failure is audited asynchronously (a known email must not answer measurably slower).
      const security = await waitFor(async () => {
        const body = (await request(admin).get('/admin/v1/security/overview').set(root.headers).expect(200)).body as SecurityOverviewDto;
        return body.failedLogins24h >= 1 ? body : null;
      });
      expect(security.recentFailures[0]).toMatchObject({ action: 'staff.login_failed' });
      expect(security.staff.find((row) => row.email === 'finance@ops.example')).toMatchObject({ role: 'FINANCE', mfaEnabled: true, disabled: false, activeSessions: 1 });
      await request(admin).get('/admin/v1/security/overview').set(support.headers).expect(403);
      // Finance audits (audit:read) but does not see the staff roster (staff:read).
      const asFinance = (await request(admin).get('/admin/v1/security/overview').set(finance.headers).expect(200)).body as SecurityOverviewDto;
      expect(asFinance.staff).toEqual([]);
      expect(asFinance.failedLogins24h).toBeGreaterThanOrEqual(1);
    });
  });

  describe('operator EPG (9.7)', () => {
    let origin: FakeOrigin;
    const HOUR = 3_600_000;
    const stamp = (date: Date) => `${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)} +0000`;
    const hourStart = new Date(Math.floor(Date.now() / HOUR) * HOUR);
    const programmes = (channel: string, from: number, count: number, skip: number[] = []) =>
      Array.from({ length: count }, (_, i) => i)
        .filter((i) => !skip.includes(i))
        .map((i) => `<programme channel="${channel}" start="${stamp(new Date(hourStart.getTime() + (from + i) * HOUR))}" stop="${stamp(new Date(hourStart.getTime() + (from + i + 1) * HOUR))}"><title>${channel} show ${i}</title></programme>`)
        .join('');
    const xml = () =>
      `<?xml version="1.0"?><tv><channel id="rustavi.ge"><display-name>Rustavi Live</display-name></channel><channel id="other.tv"><display-name>Other TV</display-name></channel><channel id="unused.tv"><display-name>Nobody</display-name></channel>${programmes('rustavi.ge', -1, 31)}${programmes('other.tv', -1, 31, [3, 4, 5])}${programmes('unused.tv', -1, 5)}</tv>`;
    let guide: OperatorGuideDto;
    let hd: string;

    beforeAll(async () => {
      origin = await startOrigin((req, res) => {
        if (req.url === '/guide.xml') return void res.writeHead(200, { 'content-type': 'application/xml' }).end(xml());
        res.writeHead(404).end();
      });
    });
    afterAll(async () => origin?.close());

    const synced = (after: string | null) =>
      waitFor(async () => {
        const current = ((await request(admin).get('/admin/v1/epg/guides').set(content.headers).expect(200)).body as OperatorGuideDto[]).find((g) => g.id === guide.id)!;
        return current.sync.status === 'idle' && current.sync.lastSuccessAt && current.sync.lastSuccessAt !== after ? current : null;
      });

    it('a licensed guide is synced; channels are mapped automatically by name/tvg-id; only usable programmes are kept', async () => {
      guide = (await request(admin).post('/admin/v1/epg/guides').set(content.headers).send({ name: 'Licensed XMLTV', url: `${origin.url}/guide.xml` }).expect(201)).body as OperatorGuideDto;
      expect(guide).toMatchObject({ host: new URL(origin.url).host, status: 'active', priority: 100 });
      expect(JSON.stringify(guide)).not.toContain('/guide.xml');
      await request(admin).post('/admin/v1/epg/guides').set(content.headers).send({ name: 'Again', url: `${origin.url}/guide.xml` }).expect(409);
      await request(admin).post('/admin/v1/epg/guides').set(finance.headers).send({ name: 'x', url: `${origin.url}/x.xml` }).expect(403);
      guide = await synced(null);
      expect(guide.stats).toMatchObject({ channels: 3 });
      // unused.tv has no master channel: its programmes are not stored.
      expect(guide.stats.programmes).toBe(31);

      const coverage = (await request(admin).get('/admin/v1/epg/coverage').set(viewOnly.headers).expect(200)).body as EpgCoverageDto;
      const live = coverage.channels.find((row) => row.name === 'Rustavi Live')!;
      expect(live).toMatchObject({ status: 'ok', mapping: { guideName: 'Licensed XMLTV', epgChannelId: 'rustavi.ge', method: 'auto' }, gapMinutes24h: 0 });
      expect(live.programmes24h).toBeGreaterThanOrEqual(24);
      hd = coverage.channels.find((row) => row.name === 'Rustavi Live HD')!.channelId;
    });

    it('manual mapping wins over automatic; gaps in the schedule are reported; clearing returns to automatic', async () => {
      const found = (await request(admin).get(`/admin/v1/epg/guide-channels?q=other&guideId=${guide.id}`).set(content.headers).expect(200)).body as OperatorGuideChannelDto[];
      expect(found.map((row) => row.id)).toEqual(['other.tv']);
      await request(admin).post(`/admin/v1/channels/${hd}/epg`).set(content.headers).send({ guideId: guide.id, epgChannelId: 'missing.tv' }).expect(400);
      const before = guide.sync.lastSuccessAt;
      await request(admin).post(`/admin/v1/channels/${hd}/epg`).set(content.headers).send({ guideId: guide.id, epgChannelId: 'other.tv' }).expect(204);
      guide = await synced(before); // the guide is re-read to keep other.tv's programmes
      const coverage = (await request(admin).get('/admin/v1/epg/coverage').set(content.headers).expect(200)).body as EpgCoverageDto;
      expect(coverage.channels.find((row) => row.channelId === hd)).toMatchObject({ status: 'gaps', mapping: { epgChannelId: 'other.tv', method: 'manual' }, gapMinutes24h: 180 });

      await request(admin).delete(`/admin/v1/channels/${hd}/epg`).set(content.headers).expect(204);
      const after = (await request(admin).get('/admin/v1/epg/coverage').set(content.headers).expect(200)).body as EpgCoverageDto;
      expect(after.channels.find((row) => row.channelId === hd)!.mapping).toMatchObject({ epgChannelId: 'rustavi.ge', method: 'auto' });
      const audit = (await request(admin).get('/admin/v1/audit?action=epg.mapping_set').set(root.headers).expect(200)).body as AuditPageDto;
      expect(audit.items).toHaveLength(1);
    });

    it('viewers see what is on now and next — only on channels in their list', async () => {
      const cr = ((await request(admin).post(`/admin/v1/channels/${channel.id}/grants`).set(content.headers).send({ territory: '*', deviceClasses: ['web'], businessModels: ['fast'], startAt: new Date(Date.now() - 60_000).toISOString(), contractRef: 'FAST-1' }).expect(202)).body as ChangeRequestedDto).changeRequest;
      await decide(content2, cr.id, 'approve').expect(200);
      // Listed only with a playable feed: a licensed stream of it from a provider.
      const providers = (await request(admin).get('/admin/v1/providers').set(content.headers).expect(200)).body as ProviderDto[];
      const licensor = providers.find((p) => p.name === 'Licensor A')!;
      await request(admin).patch(`/admin/v1/providers/${licensor.id}`).set(content.headers).send({ config: { channels: [{ id: 'r', name: 'Rustavi Live', url: `${origin.url}/live/r.ts` }] } }).expect(200);
      await waitFor(async () => (((await request(admin).get(`/admin/v1/channels/${channel.id}`).set(content.headers)).body as MasterChannelDetailDto).feeds.length > 0 ? true : null));
      const viewer = ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token;
      const guideNow = (await request(t.app).get(`/api/v1/operator/guide?channels=${channel.id},${hd}`).set({ Authorization: `Bearer ${viewer}` }).expect(200)).body as OperatorNowNextDto[];
      // hd has no rights: not in the viewer's list, so not answered.
      expect(guideNow).toHaveLength(1);
      expect(guideNow[0]).toMatchObject({ channelId: channel.id, now: { title: 'rustavi.ge show 1' }, next: { title: 'rustavi.ge show 2' } });
    });
  });
});

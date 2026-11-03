import { describe, expect, it } from 'vitest';

import type { RightsGrant } from '../operator/rights.js';
import { decideAccess, limitsOf, type AccessInput } from './entitlement.js';
import { accessUntil, addPeriod, applySubscriptionEvent, grantsAccess, startSubscription, type DunningPolicy, type SubscriptionEvent, type SubscriptionState } from './subscription.js';

const DAY = 86_400_000;
const t0 = new Date('2026-10-01T00:00:00Z');
const at = (days: number) => new Date(t0.getTime() + days * DAY);
const policy: DunningPolicy = { pastDueMs: 3 * DAY, graceMs: 4 * DAY };
const run = (state: SubscriptionState, ...events: SubscriptionEvent[]) => events.reduce((current, event) => applySubscriptionEvent(current, event, policy).state, state);

describe('subscription state machine', () => {
  const paid = () => startSubscription({ at: t0, periodStart: t0, periodEnd: at(30) });

  it('trial → active on payment; an unpaid trial gets the retry window only (no grace), then expires', () => {
    const trial = startSubscription({ at: t0, trialEndsAt: at(7) });
    expect(trial.status).toBe('trialing');
    expect(accessUntil(trial, policy)).toEqual(at(10));
    expect(run(trial, { type: 'payment_succeeded', at: at(7), periodStart: at(7), periodEnd: at(37) })).toMatchObject({ status: 'active', currentPeriodEnd: at(37) });
    expect(run(trial, { type: 'tick', at: at(7) }).status).toBe('past_due');
    expect(run(trial, { type: 'tick', at: at(10) })).toMatchObject({ status: 'expired', endedAt: at(10) });
    // A conversion charge that succeeds during the retries still converts.
    expect(run(trial, { type: 'tick', at: at(8) }, { type: 'payment_succeeded', at: at(9), periodStart: at(9), periodEnd: at(39) }).status).toBe('active');
    expect(() => startSubscription({ at: t0, trialEndsAt: t0 })).toThrow();
  });

  it('renewal: period end → past_due → grace → expired; a payment in dunning restores active', () => {
    const state = paid();
    expect(run(state, { type: 'tick', at: at(29) }).status).toBe('active');
    expect(run(state, { type: 'tick', at: at(30) }).status).toBe('past_due');
    expect(run(state, { type: 'payment_failed', at: at(30) }).status).toBe('past_due');
    expect(run(state, { type: 'tick', at: at(33) }).status).toBe('grace');
    expect(run(state, { type: 'tick', at: at(37) }).status).toBe('expired');
    expect(run(state, { type: 'tick', at: at(34) }, { type: 'payment_succeeded', at: at(34), periodStart: at(30), periodEnd: at(60) })).toMatchObject({ status: 'active', currentPeriodEnd: at(60) });
    // A failed charge before the period is over changes nothing.
    expect(applySubscriptionEvent(state, { type: 'payment_failed', at: at(10) }, policy).ignored).toBe('paid period still running');
  });

  it('webhooks may repeat or arrive out of order: only periods that extend access count', () => {
    const renewed = run(paid(), { type: 'payment_succeeded', at: at(30), periodStart: at(30), periodEnd: at(60) });
    const replay = applySubscriptionEvent(renewed, { type: 'payment_succeeded', at: at(31), periodStart: at(30), periodEnd: at(60) }, policy);
    expect(replay).toMatchObject({ changed: false, ignored: 'period already covered' });
    const late = applySubscriptionEvent(renewed, { type: 'payment_succeeded', at: at(31), periodStart: t0, periodEnd: at(30) }, policy);
    expect(late.state.currentPeriodEnd).toEqual(at(60));
  });

  it('cancel at period end keeps access until then; withdrawing it before the end restores renewal', () => {
    const cancelling = run(paid(), { type: 'cancel_requested', at: at(10), atPeriodEnd: true });
    expect(cancelling).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    expect(accessUntil(cancelling, policy)).toEqual(at(30));
    expect(run(cancelling, { type: 'tick', at: at(30) })).toMatchObject({ status: 'canceled', endedAt: at(30) });
    expect(run(cancelling, { type: 'cancel_withdrawn', at: at(20) }, { type: 'tick', at: at(30) }).status).toBe('past_due');
    expect(applySubscriptionEvent(run(cancelling, { type: 'tick', at: at(31) }), { type: 'cancel_withdrawn', at: at(31) }, policy).ignored).toMatch(/canceled/);
  });

  it('cancel now, cancel in dunning and refunds end access immediately; terminal states stay terminal', () => {
    expect(run(paid(), { type: 'cancel_requested', at: at(5), atPeriodEnd: false })).toMatchObject({ status: 'canceled', endedAt: at(5) });
    expect(run(paid(), { type: 'tick', at: at(31) }, { type: 'cancel_requested', at: at(31), atPeriodEnd: true }).status).toBe('canceled');
    const refunded = run(paid(), { type: 'refunded', at: at(2) });
    expect(refunded).toMatchObject({ status: 'canceled', endedAt: at(2) });
    expect(applySubscriptionEvent(refunded, { type: 'payment_succeeded', at: at(3), periodStart: at(3), periodEnd: at(33) }, policy)).toMatchObject({ changed: false, ignored: 'subscription is canceled' });
    expect(accessUntil(refunded, policy)).toBeNull();
  });

  it('access window and helpers', () => {
    expect(['trialing', 'active', 'past_due', 'grace'].every((s) => grantsAccess(s as never))).toBe(true);
    expect(grantsAccess('expired')).toBe(false);
    expect(accessUntil(paid(), policy)).toEqual(at(37));
    expect(addPeriod(new Date('2026-01-31T10:00:00Z'), 'month').toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addPeriod(new Date('2026-10-28T10:00:00Z'), 'year').toISOString()).toBe('2027-10-28T10:00:00.000Z');
  });
});

describe('entitlement engine', () => {
  const grant = (models: RightsGrant['businessModels'], territory = 'GE'): RightsGrant => ({ id: 'g', channelId: 'c', territory, deviceClasses: ['web', 'tv'], businessModels: models, startAt: at(-10), endAt: null, status: 'active', catchupDays: 0 });
  const basic = { id: 'basic', businessModel: 'subscription' as const, maxStreams: 2, maxDevices: 4 };
  const input = (patch: Partial<AccessInput> = {}): AccessInput => ({
    now: t0,
    mode: 'subscription',
    blocked: false,
    country: 'GE',
    device: 'web',
    grants: [grant(['subscription'])],
    entitlements: [{ packageId: 'basic', startsAt: at(-1), endsAt: at(30), revoked: false }],
    channelPackages: [basic],
    ...patch,
  });

  it('allows an entitled viewer and says why', () => {
    expect(decideAccess(input())).toEqual({ allowed: true, via: { kind: 'package', packageId: 'basic' } });
  });

  it('denies in a clear order: blocked → rights → subscription → package', () => {
    expect(decideAccess(input({ blocked: true }))).toEqual({ allowed: false, reason: 'account_blocked' });
    expect(decideAccess(input({ country: 'US' }))).toEqual({ allowed: false, reason: 'territory' });
    expect(decideAccess(input({ device: 'stb' }))).toEqual({ allowed: false, reason: 'device' });
    expect(decideAccess(input({ grants: [] }))).toEqual({ allowed: false, reason: 'not_licensed' });
    expect(decideAccess(input({ entitlements: [] }))).toEqual({ allowed: false, reason: 'no_subscription' });
    expect(decideAccess(input({ entitlements: [{ packageId: 'basic', startsAt: at(-40), endsAt: at(-1), revoked: false }] }))).toEqual({ allowed: false, reason: 'no_subscription' });
    expect(decideAccess(input({ entitlements: [{ packageId: 'basic', startsAt: at(-1), endsAt: null, revoked: true }] }))).toEqual({ allowed: false, reason: 'no_subscription' });
    expect(decideAccess(input({ channelPackages: [] }))).toEqual({ allowed: false, reason: 'not_in_package' });
  });

  it('a package only sells a channel its licence allows to be sold that way; FAST is free; rights mode skips commerce', () => {
    expect(decideAccess(input({ channelPackages: [{ ...basic, businessModel: 'b2b' }] }))).toEqual({ allowed: false, reason: 'not_in_package' });
    expect(decideAccess(input({ grants: [grant(['fast'])], entitlements: [] }))).toEqual({ allowed: true, via: { kind: 'fast' } });
    expect(decideAccess(input({ mode: 'rights', entitlements: [] }))).toEqual({ allowed: true, via: { kind: 'rights' } });
    expect(decideAccess(input({ mode: 'rights', country: 'US' }))).toEqual({ allowed: false, reason: 'territory' });
  });

  it('limits come from the most generous active package', () => {
    const premium = { id: 'premium', businessModel: 'subscription' as const, maxStreams: 4, maxDevices: 6 };
    const entitlements = [
      { packageId: 'basic', startsAt: at(-1), endsAt: at(30), revoked: false },
      { packageId: 'premium', startsAt: at(-1), endsAt: at(-0.5), revoked: false },
    ];
    expect(limitsOf([basic, premium], entitlements, t0, { maxStreams: 1, maxDevices: 2 })).toEqual({ maxStreams: 2, maxDevices: 4 });
    expect(limitsOf([basic], [], t0, { maxStreams: 1, maxDevices: 2 })).toEqual({ maxStreams: 1, maxDevices: 2 });
  });
});

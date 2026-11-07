import { describe, expect, it } from 'vitest';

import type { FeedRight } from '../operator/vendor-feed.js';
import { decideAccess, type PackageView } from './entitlement.js';
import { applyPromo, changedTerms, decideVod, licensedRight, planCatchupDays, priceFor, prorate, stricterQuality, widerQuality, type PlanTerms, type PromoView } from './plan.js';

const t0 = new Date('2026-11-06T12:00:00Z');
const day = (n: number) => new Date(t0.getTime() + n * 86_400_000);

const right = (patch: Partial<FeedRight> = {}): FeedRight => ({ territories: ['GE'], devices: ['web', 'tv'], models: ['subscription'], start: day(-10), end: null, catchupDays: 7, maxQuality: null, ...patch });
const plan = (patch: Partial<PlanTerms> = {}): PlanTerms => ({ id: 'basic', businessModel: 'subscription', vodMode: 'none', vodPackages: [], maxQuality: null, catchupDays: null, maxStreams: 1, maxDevices: 2, ...patch });

describe('plan limits narrow the licence', () => {
  it('quality: the stricter ceiling wins; of two plans the wider one applies', () => {
    expect(stricterQuality(null, 'hd')).toBe('hd');
    expect(stricterQuality('fhd', 'hd')).toBe('hd');
    expect(stricterQuality('uhd', null)).toBe('uhd');
    expect(stricterQuality(null, null)).toBeNull();
    expect(widerQuality('hd', 'uhd')).toBe('uhd');
    expect(widerQuality('hd', null)).toBeNull();
  });

  it('catch-up: the plan caps the licensed days, never extends them', () => {
    expect(planCatchupDays(7, null)).toBe(7);
    expect(planCatchupDays(7, 3)).toBe(3);
    expect(planCatchupDays(2, 14)).toBe(2);
    expect(planCatchupDays(7, 0)).toBe(0);
  });

  it('a channel in two held plans is watched under the one that gives more (quality, then archive)', () => {
    const grant = { id: 'g', channelId: 'c', territory: 'GE', deviceClasses: ['web'] as const, businessModels: ['subscription'] as const, startAt: day(-1), endAt: null, status: 'active' as const, catchupDays: 7, maxQuality: null };
    const basic: PackageView = { id: 'basic', businessModel: 'subscription', maxStreams: 1, maxDevices: 2, maxQuality: 'hd', catchupDays: 1 };
    const premium: PackageView = { id: 'premium', businessModel: 'subscription', maxStreams: 2, maxDevices: 4, maxQuality: 'uhd', catchupDays: 7 };
    const entitlements = [basic, premium].map((pkg) => ({ packageId: pkg.id, startsAt: day(-1), endsAt: null, revoked: false }));
    const decision = decideAccess({ now: t0, mode: 'subscription', blocked: false, country: 'GE', device: 'web', grants: [grant], entitlements, channelPackages: [basic, premium] });
    expect(decision).toEqual({ allowed: true, via: { kind: 'package', packageId: 'premium' } });
  });
});

describe('VOD: one engine for included / package / none', () => {
  const item = { packages: ['pkg-gold'], rights: [right()] };
  const decide = (plans: PlanTerms[], patch: Partial<Parameters<typeof decideVod>[0]> = {}) => decideVod({ now: t0, blocked: false, country: 'GE', device: 'web', item, plans, ...patch });

  it('included opens every licensed item; package only those in its vendor packages; none nothing', () => {
    expect(decide([plan({ vodMode: 'included' })])).toEqual({ allowed: true, planId: 'basic', maxQuality: null });
    expect(decide([plan({ vodMode: 'package', vodPackages: ['pkg-gold'] })])).toMatchObject({ allowed: true });
    expect(decide([plan({ vodMode: 'package', vodPackages: ['pkg-silver'] })])).toEqual({ allowed: false, reason: 'not_in_plan', maxQuality: null });
    expect(decide([plan({ vodMode: 'none' })])).toEqual({ allowed: false, reason: 'not_in_plan', maxQuality: null });
    expect(decide([])).toEqual({ allowed: false, reason: 'no_subscription', maxQuality: null });
  });

  it('the licence comes first: territory, device, window, model; a blocked account sees nothing', () => {
    const open = [plan({ vodMode: 'included' })];
    expect(decide(open, { country: 'US' })).toMatchObject({ allowed: false, reason: 'not_licensed' });
    expect(decide(open, { device: 'stb' })).toMatchObject({ allowed: false, reason: 'not_licensed' });
    expect(decide(open, { item: { ...item, rights: [right({ end: day(-1) })] } })).toMatchObject({ allowed: false, reason: 'not_licensed' });
    expect(decide(open, { item: { ...item, rights: [right({ models: ['fast'] })] } })).toMatchObject({ allowed: false, reason: 'not_licensed' });
    expect(decide(open, { blocked: true })).toMatchObject({ allowed: false, reason: 'account_blocked' });
    // A B2B plan needs a licence for B2B.
    expect(decide([plan({ vodMode: 'included', businessModel: 'b2b' })])).toMatchObject({ allowed: false, reason: 'not_in_plan' });
  });

  it('quality: the licence ceiling narrowed by the plan; the best of several plans applies', () => {
    const capped = { ...item, rights: [right({ maxQuality: 'fhd' })] };
    expect(decide([plan({ vodMode: 'included', maxQuality: 'hd' })], { item: capped })).toMatchObject({ allowed: true, maxQuality: 'hd' });
    expect(decide([plan({ vodMode: 'included' })], { item: capped })).toMatchObject({ allowed: true, maxQuality: 'fhd' });
    const hd = plan({ id: 'hd', vodMode: 'included', maxQuality: 'hd' });
    const uhd = plan({ id: 'uhd', vodMode: 'included', maxQuality: 'uhd' });
    expect(decide([hd, uhd])).toMatchObject({ allowed: true, planId: 'uhd', maxQuality: 'uhd' });
  });

  it('the most generous covering right is used (worldwide and local rights)', () => {
    const rights = [right({ territories: ['*'], maxQuality: 'sd' }), right({ territories: ['GE'], maxQuality: 'uhd' })];
    expect(licensedRight(rights, { country: 'GE', device: 'web', at: t0, model: 'subscription' })?.maxQuality).toBe('uhd');
    expect(licensedRight(rights, { country: 'DE', device: 'web', at: t0, model: 'subscription' })?.maxQuality).toBe('sd');
  });
});

describe('prices, promo codes, proration', () => {
  const base = { priceMinor: 1999, currency: 'GEL' };
  const regional = [
    { country: 'DE', currency: 'EUR', priceMinor: 799 },
    { country: 'US', currency: 'USD', priceMinor: 899 },
  ];

  it('the price of the viewer’s country, else the base price', () => {
    expect(priceFor(base, regional, 'DE')).toEqual({ priceMinor: 799, currency: 'EUR', country: 'DE' });
    expect(priceFor(base, regional, 'GE')).toEqual({ priceMinor: 1999, currency: 'GEL', country: null });
    expect(priceFor(base, regional, null)).toEqual({ priceMinor: 1999, currency: 'GEL', country: null });
  });

  const promo = (patch: Partial<PromoView> = {}): PromoView => ({ code: 'SPRING', kind: 'percent', value: 25, currency: null, families: [], maxRedemptions: null, redemptions: 0, startsAt: day(-1), endsAt: day(10), active: true, ...patch });
  const ctx = { family: 'fam-basic', now: t0, usedByViewer: false };

  it('percent and fixed discounts on the first payment, never below zero', () => {
    expect(applyPromo(base, promo(), ctx)).toEqual({ ok: true, priceMinor: 1499, discountMinor: 500 });
    expect(applyPromo(base, promo({ kind: 'amount', value: 500, currency: 'GEL' }), ctx)).toEqual({ ok: true, priceMinor: 1499, discountMinor: 500 });
    expect(applyPromo(base, promo({ kind: 'amount', value: 5000, currency: 'GEL' }), ctx)).toEqual({ ok: true, priceMinor: 0, discountMinor: 1999 });
    expect(applyPromo(base, promo({ value: 100 }), ctx)).toEqual({ ok: true, priceMinor: 0, discountMinor: 1999 });
  });

  it('refuses a code that is off, early, late, used up, for another plan or currency, or used before', () => {
    expect(applyPromo(base, promo({ active: false }), ctx)).toEqual({ ok: false, problem: 'inactive' });
    expect(applyPromo(base, promo({ startsAt: day(1) }), ctx)).toEqual({ ok: false, problem: 'not_started' });
    expect(applyPromo(base, promo({ endsAt: t0 }), ctx)).toEqual({ ok: false, problem: 'expired' });
    expect(applyPromo(base, promo({ maxRedemptions: 3, redemptions: 3 }), ctx)).toEqual({ ok: false, problem: 'exhausted' });
    expect(applyPromo(base, promo({ families: ['fam-premium'] }), ctx)).toEqual({ ok: false, problem: 'not_for_plan' });
    expect(applyPromo(base, promo({ kind: 'amount', value: 500, currency: 'EUR' }), ctx)).toEqual({ ok: false, problem: 'currency' });
    expect(applyPromo(base, promo(), { ...ctx, usedByViewer: true })).toEqual({ ok: false, problem: 'already_used' });
    expect(applyPromo(base, promo({ families: ['fam-basic'] }), ctx)).toMatchObject({ ok: true });
  });

  it('proration: credit for the unused time, the rest of the period at the new price', () => {
    const period = { periodStart: day(-15), periodEnd: day(15) };
    // Halfway: 9.99 → 19.99 owes half the difference now.
    expect(prorate({ current: { priceMinor: 999, currency: 'GEL' }, next: { priceMinor: 1999, currency: 'GEL' }, ...period, at: t0 })).toEqual({ creditMinor: 500, chargeMinor: 1000, dueNowMinor: 500, carryMinor: 0, remaining: 0.5 });
    // Downgrade: the difference is kept as credit.
    expect(prorate({ current: { priceMinor: 1999, currency: 'GEL' }, next: { priceMinor: 999, currency: 'GEL' }, ...period, at: t0 })).toMatchObject({ dueNowMinor: 0, carryMinor: 500 });
    // At (or after) the period end nothing is left to prorate.
    expect(prorate({ current: { priceMinor: 999, currency: 'GEL' }, next: { priceMinor: 1999, currency: 'GEL' }, ...period, at: day(20) })).toMatchObject({ creditMinor: 0, chargeMinor: 0, remaining: 0 });
    expect(() => prorate({ current: { priceMinor: 999, currency: 'GEL' }, next: { priceMinor: 799, currency: 'EUR' }, ...period, at: t0 })).toThrow();
  });
});

describe('versions', () => {
  const before = { priceMinor: 999, currency: 'GEL', billingPeriod: 'month', maxStreams: 1, maxDevices: 2, businessModel: 'subscription', vodMode: 'none', vodPackages: ['a', 'b'], maxQuality: 'hd', catchupDays: 3, prices: [{ country: 'DE', currency: 'EUR', priceMinor: 499 }] };

  it('names the bought terms a change touches (arrays compared without order); name/trial/status are not versioned', () => {
    expect(changedTerms(before, { priceMinor: 1299 })).toEqual(['priceMinor']);
    expect(changedTerms(before, { priceMinor: 999, vodPackages: ['b', 'a'] })).toEqual([]);
    expect(changedTerms(before, { vodMode: 'included', maxQuality: null, catchupDays: 3 })).toEqual(['vodMode', 'maxQuality']);
    expect(changedTerms(before, { prices: [{ country: 'DE', currency: 'EUR', priceMinor: 599 }] })).toEqual(['prices']);
    expect(changedTerms(before, { name: 'Basic+', trialDays: 7, status: 'retired' } as never)).toEqual([]);
  });
});

import type { DeviceClass } from '../operator/catalog.js';
import { expandRights, QUALITIES, type FeedRight, type Quality } from '../operator/vendor-feed.js';

/**
 * The commercial catalogue (Phase 17). A plan is a set of entitlements — channels, a VOD mode,
 * a quality ceiling, catch-up days, streams and devices — and the business model is data: whether
 * films are unlimited, sold through vendor packages or not sold at all is a plan setting.
 *
 * Everything here is pure; prices, promos and proration are integers in minor units.
 */

export const VOD_MODES = ['included', 'package', 'none'] as const;
/** included: every licensed film/series · package: those in the plan's vendor packages · none: no VOD (later: tvod). */
export type VodMode = (typeof VOD_MODES)[number];

export interface PlanTerms {
  id: string;
  /** Commercial model of the plan (the licence must allow selling the content that way). */
  businessModel: 'subscription' | 'b2b';
  vodMode: VodMode;
  /** Vendor packages (provider_packages ids) a `package` plan opens. */
  vodPackages: readonly string[];
  /** Picture ceiling of the plan (null = whatever the licence allows). */
  maxQuality: Quality | null;
  /** Archive days of the plan (null = whatever the licence allows). */
  catchupDays: number | null;
  maxStreams: number;
  maxDevices: number;
}

// --- limits: the plan narrows the licence, never widens it -----------------------------------------

/** The stricter of two quality ceilings (null = no ceiling). */
export function stricterQuality(a: Quality | null, b: Quality | null): Quality | null {
  if (a === null) return b;
  if (b === null) return a;
  return QUALITIES.indexOf(a) <= QUALITIES.indexOf(b) ? a : b;
}

/** The more generous of two plan ceilings (two entitlements → the better one applies). */
export function widerQuality(a: Quality | null, b: Quality | null): Quality | null {
  if (a === null || b === null) return null;
  return QUALITIES.indexOf(a) >= QUALITIES.indexOf(b) ? a : b;
}

/** Archive days a viewer gets: the licence's, capped by the plan (null = no plan cap). */
export function planCatchupDays(licensed: number, plan: number | null): number {
  return plan === null ? licensed : Math.min(licensed, plan);
}

/** Orders plans by what they give on a channel: quality first, then archive days. */
export function morePlan(a: Pick<PlanTerms, 'maxQuality' | 'catchupDays'>, b: Pick<PlanTerms, 'maxQuality' | 'catchupDays'>): number {
  const rank = (quality: Quality | null) => (quality === null ? QUALITIES.length : QUALITIES.indexOf(quality));
  return rank(a.maxQuality) - rank(b.maxQuality) || (a.catchupDays ?? 31) - (b.catchupDays ?? 31);
}

// --- VOD: one decision for every mode ----------------------------------------------------------------

export interface VodItemView {
  /** provider_packages ids the item belongs to. */
  packages: readonly string[];
  rights: readonly FeedRight[];
}

export type VodDenial = 'account_blocked' | 'not_licensed' | 'no_subscription' | 'not_in_plan';

export type VodDecision = { allowed: true; planId: string; maxQuality: Quality | null } | { allowed: false; reason: VodDenial; maxQuality: Quality | null };

/**
 * May a viewer watch this film/series? The licence first (a right of the vendor covers the
 * viewer's country, device and the plan's business model, now), then the plans the viewer holds:
 *   included → every licensed item · package → items in one of its vendor packages · none → nothing.
 * The quality ceiling is the licence's, narrowed by the plan.
 */
export function decideVod(input: { now: Date; blocked: boolean; country: string | null; device: DeviceClass; item: VodItemView; plans: readonly PlanTerms[] }): VodDecision {
  if (input.blocked) return { allowed: false, reason: 'account_blocked', maxQuality: null };
  const licensed = (model: 'subscription' | 'b2b' | 'fast') => licensedRight(input.item.rights, { country: input.country, device: input.device, at: input.now, model });
  if (!licensed('subscription') && !licensed('b2b')) return { allowed: false, reason: 'not_licensed', maxQuality: null };
  const opening = input.plans.filter((plan) => opensVod(plan, input.item) && licensed(plan.businessModel));
  if (opening.length === 0) return { allowed: false, reason: input.plans.length > 0 ? 'not_in_plan' : 'no_subscription', maxQuality: null };
  const best = [...opening].sort((a, b) => morePlan(b, a))[0]!;
  return { allowed: true, planId: best.id, maxQuality: stricterQuality(licensed(best.businessModel)!.maxQuality, best.maxQuality) };
}

/** Whether a plan's VOD mode covers the item (licence aside). */
export function opensVod(plan: Pick<PlanTerms, 'vodMode' | 'vodPackages'>, item: Pick<VodItemView, 'packages'>): boolean {
  if (plan.vodMode === 'included') return true;
  if (plan.vodMode === 'package') return item.packages.some((pkg) => plan.vodPackages.includes(pkg));
  return false;
}

/** The vendor right that covers a viewing (the most generous quality among those that do). */
export function licensedRight(rights: readonly FeedRight[], query: { country: string | null; device: DeviceClass; at: Date; model: 'subscription' | 'b2b' | 'fast' }): FeedRight | null {
  let best: FeedRight | null = null;
  for (const { territory, right } of expandRights(rights)) {
    if (territory !== '*' && territory !== query.country) continue;
    if (!right.devices.includes(query.device) || !right.models.includes(query.model)) continue;
    if (right.start.getTime() > query.at.getTime() || (right.end && right.end.getTime() <= query.at.getTime())) continue;
    if (!best || widerQuality(best.maxQuality, right.maxQuality) !== best.maxQuality) best = right;
  }
  return best;
}

// --- prices -------------------------------------------------------------------------------------------

export interface Price {
  priceMinor: number;
  currency: string;
}

export interface RegionalPrice extends Price {
  /** ISO 3166-1 alpha-2. */
  country: string;
}

/** The price in the viewer's country, else the plan's base price. */
export function priceFor(base: Price, regional: readonly RegionalPrice[], country: string | null): Price & { country: string | null } {
  const local = country ? regional.find((price) => price.country === country) : undefined;
  return local ? { priceMinor: local.priceMinor, currency: local.currency, country: local.country } : { priceMinor: base.priceMinor, currency: base.currency, country: null };
}

// --- promo codes ----------------------------------------------------------------------------------------

export interface PromoView {
  code: string;
  kind: 'percent' | 'amount';
  /** Percent (1–100) or minor units of `currency`. */
  value: number;
  currency: string | null;
  /** Plan families it applies to (empty = all). */
  families: readonly string[];
  maxRedemptions: number | null;
  redemptions: number;
  startsAt: Date;
  endsAt: Date | null;
  active: boolean;
}

export type PromoProblem = 'inactive' | 'not_started' | 'expired' | 'exhausted' | 'not_for_plan' | 'currency' | 'already_used';

/** Normalised code as typed by a viewer ("  spring-25 " → "SPRING-25"). */
export function normalizePromoCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * A promo code on a price (first payment). A fixed discount needs the same currency as the price
 * the viewer pays (a EUR code says nothing about a GEL price); the result never goes below zero.
 */
export function applyPromo(price: Price, promo: PromoView, context: { family: string; now: Date; usedByViewer: boolean }): { ok: true; priceMinor: number; discountMinor: number } | { ok: false; problem: PromoProblem } {
  if (!promo.active) return { ok: false, problem: 'inactive' };
  if (promo.startsAt > context.now) return { ok: false, problem: 'not_started' };
  if (promo.endsAt && promo.endsAt <= context.now) return { ok: false, problem: 'expired' };
  if (promo.maxRedemptions !== null && promo.redemptions >= promo.maxRedemptions) return { ok: false, problem: 'exhausted' };
  if (promo.families.length > 0 && !promo.families.includes(context.family)) return { ok: false, problem: 'not_for_plan' };
  if (context.usedByViewer) return { ok: false, problem: 'already_used' };
  let discount: number;
  if (promo.kind === 'percent') discount = Math.round((price.priceMinor * promo.value) / 100);
  else {
    if (promo.currency !== price.currency) return { ok: false, problem: 'currency' };
    discount = promo.value;
  }
  discount = Math.min(discount, price.priceMinor);
  return { ok: true, priceMinor: price.priceMinor - discount, discountMinor: discount };
}

// --- proration ------------------------------------------------------------------------------------------

export interface Proration {
  /** Unused part of the current period at the current price. */
  creditMinor: number;
  /** The rest of the period at the new price. */
  chargeMinor: number;
  /** charge − credit when positive: collected now (upgrade). */
  dueNowMinor: number;
  /** credit − charge when positive: left as account credit for the next invoices (downgrade). */
  carryMinor: number;
  /** Share of the period left (0–1). */
  remaining: number;
}

/**
 * Plan change in the middle of a paid period: the unused time of the current plan is credited,
 * the rest of the period is charged at the new plan's price. Both prices are per period and in
 * the same currency (a change across currencies is not prorated: it waits for the period end).
 */
export function prorate(input: { current: Price; next: Price; periodStart: Date; periodEnd: Date; at: Date }): Proration {
  if (input.current.currency !== input.next.currency) throw new Error('Proration needs one currency');
  const length = input.periodEnd.getTime() - input.periodStart.getTime();
  if (length <= 0) throw new Error('Invalid period');
  const remaining = Math.min(1, Math.max(0, (input.periodEnd.getTime() - input.at.getTime()) / length));
  const creditMinor = Math.round(input.current.priceMinor * remaining);
  const chargeMinor = Math.round(input.next.priceMinor * remaining);
  return { creditMinor, chargeMinor, dueNowMinor: Math.max(0, chargeMinor - creditMinor), carryMinor: Math.max(0, creditMinor - chargeMinor), remaining: Math.round(remaining * 10_000) / 10_000 };
}

// --- versions -------------------------------------------------------------------------------------------

/**
 * Terms a holder bought: changing any of them on a plan that people hold creates a new version
 * (holders keep theirs). Name, description, trial, status and channels are not versioned —
 * channels follow the licence and are shared by every version of the plan.
 */
export const VERSIONED_TERMS = ['priceMinor', 'currency', 'billingPeriod', 'maxStreams', 'maxDevices', 'businessModel', 'vodMode', 'vodPackages', 'maxQuality', 'catchupDays', 'prices'] as const;
export type VersionedTerm = (typeof VERSIONED_TERMS)[number];

/** The versioned terms a change touches (compared by value; arrays order-free). */
export function changedTerms(before: Record<VersionedTerm, unknown>, patch: Partial<Record<VersionedTerm, unknown>>): VersionedTerm[] {
  return VERSIONED_TERMS.filter((term) => patch[term] !== undefined && canonical(patch[term]) !== canonical(before[term]));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.stringify(item)).sort());
  return JSON.stringify(value ?? null);
}

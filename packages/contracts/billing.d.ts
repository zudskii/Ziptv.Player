// Commerce and playback authorization (Phase 8).

import type { PlaybackPlanDto } from './playback';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'grace' | 'canceled' | 'expired';
export type DevicePlatform = 'web' | 'mobile' | 'tv' | 'stb';
/** Phase 17 — what a plan gives in films and series: all licensed, those in its vendor packages, none. */
export type VodMode = 'included' | 'package' | 'none';
export type PlanQuality = 'sd' | 'hd' | 'fhd' | 'uhd';
export type PromoProblem = 'unknown' | 'inactive' | 'not_started' | 'expired' | 'exhausted' | 'not_for_plan' | 'currency' | 'already_used';

/** A price in one country (ISO 3166-1 alpha-2); elsewhere the plan's base price applies. */
export interface RegionalPriceDto {
  country: string;
  currency: string;
  priceMinor: number;
}

// --- viewer (/api/v1) --------------------------------------------------------------------------

export interface PackageOfferDto {
  id: string;
  slug: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  billingPeriod: 'month' | 'year';
  /** Trial days this viewer would get (0 = none / already used). */
  trialDays: number;
  maxDevices: number;
  maxStreams: number;
  channels: number;
  /** Phase 17 — the plan's entitlements beyond channels. */
  vodMode: VodMode;
  /** Highest picture quality (null = whatever each channel's licence allows). */
  maxQuality: PlanQuality | null;
  /** Days of catch-up (null = whatever each channel's licence allows). */
  catchupDays: number | null;
  /** The country whose price is shown (null = the base price). */
  priceCountry: string | null;
}

export interface StartCheckoutRequest {
  packageId: string;
  promoCode?: string;
}

/** `POST /billing/quote` — the price the viewer would pay, with a promo code checked. */
export interface CheckoutQuoteRequest {
  packageId: string;
  promoCode?: string;
}

export interface CheckoutQuoteDto {
  packageId: string;
  priceMinor: number;
  currency: string;
  billingPeriod: 'month' | 'year';
  trialDays: number;
  promo: { code: string; discountMinor: number; firstPaymentMinor: number } | null;
  /** Why the given code does not apply (null = it applies, or none was given). */
  promoProblem: PromoProblem | null;
}

/** `POST /billing/subscription/change/quote` and `…/change` — move to another plan now, prorated. */
export interface ChangePlanRequest {
  packageId: string;
}

export interface PlanChangeQuoteDto {
  from: { packageId: string; name: string; priceMinor: number; currency: string };
  to: { packageId: string; name: string; priceMinor: number; currency: string };
  /** Unused part of the current period (credited), the rest of it at the new price (charged). */
  creditMinor: number;
  chargeMinor: number;
  /** Collected now (upgrade). */
  dueNowMinor: number;
  /** Kept as credit for the next invoices (downgrade). */
  carryMinor: number;
  /** Share of the period left (0–1). */
  remaining: number;
}

export interface CheckoutStartedDto {
  checkoutId: string;
  /** The processor's hosted payment page. */
  redirectUrl: string;
}

export interface CheckoutStatusDto {
  checkoutId: string;
  /** `completed` only once the payment is verified (webhook or processor query) — never because the browser came back. */
  status: 'open' | 'completed' | 'expired';
  subscription: SubscriptionDto | null;
}

export interface SubscriptionDto {
  id: string;
  status: SubscriptionStatus;
  package: { id: string; slug: string; name: string };
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Until when this subscription gives access without a further payment (null = no access). */
  accessUntil: string | null;
  /** What this subscriber pays per period (null = unknown, before Phase 17). */
  price: { amountMinor: number; currency: string } | null;
  /** The plan has a newer version: this subscriber keeps the terms they bought. */
  grandfathered: boolean;
}

export interface EntitlementDto {
  id: string;
  package: { id: string; slug: string; name: string };
  kind: 'subscription' | 'comp';
  startsAt: string;
  endsAt: string | null;
  active: boolean;
}

export interface InvoiceDto {
  id: string;
  amountMinor: number;
  currency: string;
  status: 'paid' | 'refunded';
  periodStart: string;
  periodEnd: string;
  paidAt: string;
}

export interface DeviceDto {
  id: string;
  name: string;
  platform: DevicePlatform;
  createdAt: string;
  lastSeenAt: string;
  /** The device this request came from. */
  current: boolean;
}

export interface ActivePlaybackDto {
  playbackSessionId: string;
  deviceId: string;
  deviceName: string;
  channelId: string;
  startedAt: string;
}

export interface AccountBillingDto {
  subscription: SubscriptionDto | null;
  entitlements: EntitlementDto[];
  invoices: InvoiceDto[];
  limits: { maxDevices: number; maxStreams: number };
  devices: DeviceDto[];
  playing: ActivePlaybackDto[];
}

export interface RegisterDeviceRequest {
  /** A random secret the device keeps (≥ 32 chars); only its hash is stored. */
  key: string;
  name: string;
  platform: DevicePlatform;
}

/** `POST /operator/playback/sessions` — authorizes one viewing of an operator channel. */
export interface StartPlaybackSessionRequest {
  channelId: string;
  deviceId: string;
  secureContext: boolean;
  /** The viewer's previous playback session (zap or reconnect): it ends first and frees its stream slot. */
  replaces?: string;
  /** Reconnect of the same viewing: the previous plan's `sessionId`, so watch history keeps one entry. */
  continueSession?: string;
  /** Catch-up: replay this past programme (ISO instants) instead of the live channel. Needs catch-up rights. */
  archive?: { start: string; end: string };
}

export interface PlaybackSessionDto {
  playbackSessionId: string;
  heartbeatIntervalSeconds: number;
  /** The lease runs out unless renewed by a heartbeat. */
  expiresAt: string;
  policy: { access: 'package' | 'fast' | 'rights'; maxStreams: number; activeStreams: number };
  plan: PlaybackPlanDto;
}

export interface PlaybackHeartbeatDto {
  expiresAt: string;
}

/** Details of a 409 CONCURRENCY_LIMIT: what is playing elsewhere (stop one to watch here). */
export interface ConcurrencyLimitDetails {
  limit: number;
  playing: ActivePlaybackDto[];
}

// --- console (/admin/v1) -----------------------------------------------------------------------

export interface PackageDto extends Omit<PackageOfferDto, 'trialDays' | 'priceCountry'> {
  trialDays: number;
  businessModel: 'subscription' | 'b2b';
  status: 'draft' | 'active' | 'retired';
  createdAt: string;
  /** Vendor packages (provider package ids) a `package` VOD plan opens. */
  vodPackages: string[];
  prices: RegionalPriceDto[];
  /** Versions of one plan share the family; a changed plan that people hold gets a new version. */
  familyId: string;
  version: number;
  supersededBy: string | null;
  /** Accounts holding this version now. */
  holders: number;
}

export interface PackageDetailDto extends PackageDto {
  channelIds: string[];
  /** Every version of the plan, newest first. */
  versions: { id: string; version: number; status: 'draft' | 'active' | 'retired'; priceMinor: number; currency: string; holders: number; createdAt: string }[];
}

/** A vendor package a VOD plan can open (console picker). */
export interface ProviderPackageOptionDto {
  id: string;
  providerId: string;
  providerName: string;
  name: string;
  items: number;
  status: 'active' | 'gone';
}

export interface PromoCodeDto {
  id: string;
  code: string;
  kind: 'percent' | 'amount';
  value: number;
  currency: string | null;
  /** Plan families it applies to (empty = every plan). */
  families: string[];
  maxRedemptions: number | null;
  redemptions: number;
  startsAt: string;
  endsAt: string | null;
  active: boolean;
  note: string;
  createdAt: string;
}

export interface CreatePromoRequest {
  code: string;
  kind: 'percent' | 'amount';
  value: number;
  currency?: string;
  families?: string[];
  maxRedemptions?: number | null;
  startsAt?: string;
  endsAt?: string | null;
  note?: string;
}

/** Stopping a code acts at once (it only narrows); a new or widened code goes through approval. */
export interface UpdatePromoRequest {
  active?: false;
  note?: string;
}

export interface CreatePackageRequest {
  name: string;
  slug?: string;
  description?: string;
  priceMinor: number;
  currency: string;
  billingPeriod: 'month' | 'year';
  trialDays?: number;
  maxDevices: number;
  maxStreams: number;
  businessModel?: 'subscription' | 'b2b';
  vodMode?: VodMode;
  vodPackages?: string[];
  maxQuality?: PlanQuality | null;
  catchupDays?: number | null;
  prices?: RegionalPriceDto[];
}

export type UpdatePackageRequest = Partial<CreatePackageRequest> & { status?: 'draft' | 'active' | 'retired'; channelIds?: string[] };

export interface UserBillingDto extends AccountBillingDto {
  userId: string;
  email: string | null;
  blocked: boolean;
  blockedReason: string | null;
  subscriptions: SubscriptionDto[];
}

export interface CompEntitlementRequest {
  packageId: string;
  endsAt?: string | null;
  note: string;
}

export interface PaymentEventDto {
  id: string;
  processor: string;
  eventId: string;
  type: string;
  receivedAt: string;
  processedAt: string | null;
  outcome: string | null;
}

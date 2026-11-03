// Commerce and playback authorization (Phase 8).

import type { PlaybackPlanDto } from './playback';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'grace' | 'canceled' | 'expired';
export type DevicePlatform = 'web' | 'mobile' | 'tv' | 'stb';

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
}

export interface StartCheckoutRequest {
  packageId: string;
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

export interface PackageDto extends Omit<PackageOfferDto, 'trialDays'> {
  trialDays: number;
  businessModel: 'subscription' | 'b2b';
  status: 'draft' | 'active' | 'retired';
  createdAt: string;
}

export interface PackageDetailDto extends PackageDto {
  channelIds: string[];
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

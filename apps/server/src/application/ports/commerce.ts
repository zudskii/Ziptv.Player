import type { DeviceClass } from '../../domain/operator/catalog.js';
import type { SubscriptionState } from '../../domain/commerce/subscription.js';

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

export interface PackageRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  billingPeriod: 'month' | 'year';
  trialDays: number;
  maxDevices: number;
  maxStreams: number;
  businessModel: 'subscription' | 'b2b';
  status: 'draft' | 'active' | 'retired';
  createdAt: Date;
}

export interface SubscriptionRecord extends SubscriptionState {
  id: string;
  userId: string;
  packageId: string;
  processor: string;
  processorRef: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EntitlementRecord {
  id: string;
  userId: string;
  packageId: string;
  kind: 'subscription' | 'comp';
  subscriptionId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  revokedAt: Date | null;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  name: string;
  platform: DeviceClass;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export interface PlaybackSessionRecord {
  id: string;
  userId: string;
  profileId: string | null;
  deviceId: string;
  channelId: string;
  access: 'package' | 'fast' | 'rights';
  packageId: string | null;
  country: string | null;
  /** Provider of the feed on air when the viewing started (partner reporting). */
  providerId: string | null;
  startedAt: Date;
  lastHeartbeatAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  /** Catch-up viewing: the programme being replayed (null = live). */
  archive: { start: Date; end: Date } | null;
}

export interface CheckoutRecord {
  id: string;
  userId: string;
  packageId: string;
  processor: string;
  processorRef: string | null;
  withTrial: boolean;
  status: 'open' | 'completed' | 'expired';
  subscriptionId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface InvoiceRecord {
  id: string;
  userId: string;
  subscriptionId: string;
  processor: string;
  processorRef: string;
  amountMinor: number;
  currency: string;
  status: 'paid' | 'refunded';
  periodStart: Date;
  periodEnd: Date;
  paidAt: Date;
  refundedAt: Date | null;
}

export interface PaymentEventRecord {
  id: string;
  processor: string;
  eventId: string;
  type: string;
  receivedAt: Date;
  processedAt: Date | null;
  outcome: string | null;
}

// ---------------------------------------------------------------------------------------------
// Payment processor
// ---------------------------------------------------------------------------------------------

export interface ProcessorInvoice {
  ref: string;
  amountMinor: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  paidAt: Date;
  /** Set once the processor refunded it. */
  refundedAt?: Date | null;
}

/** The processor's view of a subscription (the source of truth for money). */
export interface ProcessorSubscription {
  ref: string;
  status: 'trialing' | 'active' | 'past_due' | 'canceled';
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  latestInvoice: ProcessorInvoice | null;
}

export type ProcessorEventType = 'checkout.completed' | 'invoice.paid' | 'invoice.payment_failed' | 'subscription.updated' | 'subscription.canceled' | 'charge.refunded';

export interface ProcessorEvent {
  /** Unique per processor: the idempotency key of the webhook. */
  id: string;
  type: ProcessorEventType;
  occurredAt: Date;
  checkoutRef: string | null;
  subscription: ProcessorSubscription;
  invoice: ProcessorInvoice | null;
}

export class WebhookSignatureError extends Error {
  constructor(message = 'Invalid webhook signature') {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

/**
 * A payment provider (Stripe, a local acquirer, …). ZIPTV never grants access because a browser
 * came back from the checkout page: only a verified webhook, or the processor's own answer to a
 * status query, changes a subscription.
 */
/** A processor-hosted payment page served by ZIPTV itself (only the built-in test processor has one). */
export interface HostedCheckoutPage {
  checkout(ref: string): { ref: string; pkg: Pick<PackageRecord, 'name' | 'priceMinor' | 'currency' | 'billingPeriod'>; trialDays: number; status: 'open' | 'paid' | 'expired' } | null;
  /** The customer pays; returns where the browser goes next. Throws when the checkout is not open. */
  pay(ref: string): string;
  /** The customer gives up; returns where the browser goes next. */
  abandon(ref: string): string;
}

export interface PaymentProcessor {
  readonly name: string;
  createCheckout(input: { checkoutId: string; userId: string; email: string | null; pkg: PackageRecord; trialDays: number; successUrl: string; cancelUrl: string }): Promise<{ ref: string; redirectUrl: string }>;
  /** Verifies the signature and parses; throws WebhookSignatureError when it is not authentic. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProcessorEvent;
  fetchCheckout(ref: string): Promise<{ status: 'open' | 'paid' | 'expired'; subscription: ProcessorSubscription | null }>;
  fetchSubscription(ref: string): Promise<ProcessorSubscription | null>;
  cancelSubscription(ref: string, atPeriodEnd: boolean): Promise<void>;
  resumeSubscription(ref: string): Promise<void>;
  refundLatestInvoice(subscriptionRef: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------------------------

export interface CommerceRepository {
  newId(): string;
  transaction<T>(work: (tx: CommerceRepository) => Promise<T>): Promise<T>;

  // packages
  listPackages(status?: PackageRecord['status']): Promise<(PackageRecord & { channels: number })[]>;
  findPackage(idOrSlug: string): Promise<PackageRecord | null>;
  findPackages(ids: string[]): Promise<PackageRecord[]>;
  createPackage(input: Omit<PackageRecord, 'createdAt'>): Promise<PackageRecord>;
  updatePackage(id: string, patch: Partial<Omit<PackageRecord, 'id' | 'createdAt'>>): Promise<PackageRecord | null>;
  packageChannels(packageId: string): Promise<string[]>;
  setPackageChannels(packageId: string, channelIds: string[]): Promise<void>;
  /** Packages (any status) that contain each channel: access follows what viewers hold, not what is on sale. */
  packagesOfChannels(channelIds: string[]): Promise<Map<string, PackageRecord[]>>;

  // subscriptions
  liveSubscription(userId: string, options?: { lock?: boolean }): Promise<SubscriptionRecord | null>;
  findSubscription(id: string, options?: { lock?: boolean }): Promise<SubscriptionRecord | null>;
  findSubscriptionByRef(processor: string, ref: string, options?: { lock?: boolean }): Promise<SubscriptionRecord | null>;
  createSubscription(record: Omit<SubscriptionRecord, 'createdAt' | 'updatedAt'>, now: Date): Promise<SubscriptionRecord>;
  saveSubscription(record: SubscriptionRecord, now: Date): Promise<void>;
  /** Live subscriptions whose paid/trial time is over (time transitions due). */
  dueSubscriptions(now: Date, limit: number): Promise<string[]>;
  /** Live subscriptions not checked against the processor since `before`. */
  subscriptionsToReconcile(before: Date, limit: number): Promise<SubscriptionRecord[]>;
  markReconciled(id: string, now: Date): Promise<void>;
  hadTrial(userId: string): Promise<boolean>;
  subscriptionsOf(userId: string): Promise<SubscriptionRecord[]>;

  // entitlements
  entitlementsOf(userId: string): Promise<EntitlementRecord[]>;
  /** The subscription's entitlement mirrors its access window. */
  syncSubscriptionEntitlement(input: { subscriptionId: string; userId: string; packageId: string; startsAt: Date; endsAt: Date | null; revoked: boolean; now: Date }): Promise<void>;
  createCompEntitlement(input: { id: string; userId: string; packageId: string; startsAt: Date; endsAt: Date | null; note: string | null; createdBy: string; now: Date }): Promise<EntitlementRecord>;
  revokeEntitlement(id: string, now: Date): Promise<EntitlementRecord | null>;

  // devices
  devicesOf(userId: string): Promise<DeviceRecord[]>;
  findDevice(id: string): Promise<DeviceRecord | null>;
  findDeviceByKey(userId: string, keyHash: string): Promise<DeviceRecord | null>;
  /** Serialises device registration of one account (the limit check cannot be raced). */
  lockAccount(userId: string): Promise<void>;
  createDevice(input: { id: string; userId: string; keyHash: string; name: string; platform: DeviceClass; now: Date }): Promise<DeviceRecord>;
  touchDevice(id: string, now: Date): Promise<void>;
  revokeDevice(id: string, now: Date): Promise<boolean>;

  // playback sessions
  createPlaybackSession(record: Omit<PlaybackSessionRecord, 'endedAt' | 'endReason'>): Promise<void>;
  findPlaybackSession(id: string): Promise<PlaybackSessionRecord | null>;
  heartbeatPlaybackSession(id: string, now: Date, expiresAt: Date): Promise<boolean>;
  endPlaybackSession(id: string, now: Date, reason: string): Promise<boolean>;
  liveSessionsOf(userId: string, now: Date): Promise<(PlaybackSessionRecord & { deviceName: string })[]>;
  liveSessionsOnChannel(channelId: string, now: Date): Promise<PlaybackSessionRecord[]>;
  /** Ends live sessions (of a device / an account) and returns their ids. */
  endSessionsWhere(filter: { deviceId?: string; userId?: string }, now: Date, reason: string): Promise<string[]>;
  /** Ends viewings whose heartbeats stopped; returns them so their leases and links can be released. */
  endExpiredSessions(now: Date): Promise<{ id: string; userId: string }[]>;
  /** The provider whose feed is on air for a channel (failover's active feed, else the best playable one). */
  servingProvider(channelId: string): Promise<string | null>;
  /** Retention: viewings that ended long ago, abandoned checkouts. Invoices and payment events stay (accounting). */
  pruneCommerce(before: { endedSessions: Date; expiredCheckouts: Date }): Promise<{ sessions: number; checkouts: number }>;

  // checkouts, invoices, payment events
  createCheckout(record: Omit<CheckoutRecord, 'createdAt' | 'completedAt' | 'status' | 'subscriptionId'>, now: Date): Promise<CheckoutRecord>;
  setCheckoutRef(id: string, ref: string): Promise<void>;
  findCheckout(id: string, options?: { lock?: boolean }): Promise<CheckoutRecord | null>;
  findCheckoutByRef(processor: string, ref: string, options?: { lock?: boolean }): Promise<CheckoutRecord | null>;
  completeCheckout(id: string, subscriptionId: string, now: Date): Promise<void>;
  openCheckouts(createdBefore: Date, limit: number): Promise<CheckoutRecord[]>;
  expireCheckout(id: string): Promise<void>;
  /** false when already recorded (the processor's invoice id is unique). */
  recordInvoice(record: InvoiceRecord): Promise<boolean>;
  refundInvoice(processor: string, ref: string, now: Date): Promise<boolean>;
  invoicesOf(userId: string): Promise<InvoiceRecord[]>;
  /** `duplicate` when this processor event was received before (webhook replay / retry). */
  recordPaymentEvent(input: { id: string; processor: string; eventId: string; type: string; payload: unknown; now: Date }): Promise<{ duplicate: boolean }>;
  markPaymentEvent(processor: string, eventId: string, outcome: string, now: Date): Promise<void>;
  paymentEvents(limit: number): Promise<PaymentEventRecord[]>;

  // accounts
  account(userId: string): Promise<{ id: string; email: string | null; blockedAt: Date | null; blockedReason: string | null } | null>;
  setBlocked(userId: string, blocked: boolean, reason: string | null, now: Date): Promise<boolean>;

  /** Side effect committed with the change (notifications, emails). */
  enqueue(topic: string, payload: Record<string, unknown>, now: Date): Promise<void>;
}

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { addPeriod } from '../../domain/commerce/subscription.js';
import {
  WebhookSignatureError,
  type CheckoutPrice,
  type HostedCheckoutPage,
  type PackageRecord,
  type PaymentProcessor,
  type ProcessorEvent,
  type ProcessorEventType,
  type ProcessorInvoice,
  type ProcessorSubscription,
} from '../../application/ports/commerce.js';
import type { Clock } from '../../application/ports/clock.js';

const SIGNATURE_HEADER = 'x-fake-signature';

interface FakeCheckout {
  ref: string;
  pkg: PackageRecord;
  price: CheckoutPrice;
  trialDays: number;
  successUrl: string;
  cancelUrl: string;
  status: 'open' | 'paid' | 'expired';
  subscriptionRef: string | null;
}

interface FakeSubscription extends ProcessorSubscription {
  pkg: PackageRecord;
  /** Recurring price per period. */
  price: { amountMinor: number; currency: string };
  /** Account credit left by a downgrade, used up by the next invoices. */
  credit: number;
}

/**
 * A payment processor that runs inside ZIPTV, for development, tests and demos. It behaves like a
 * real one where it matters: a hosted checkout page, subscriptions with trials and periods, and
 * HMAC-signed webhooks delivered *asynchronously* (after the browser is already back), so the
 * application cannot get away with trusting the redirect.
 */
export class FakePaymentProcessor implements PaymentProcessor, HostedCheckoutPage {
  readonly name = 'fake';
  private readonly checkouts = new Map<string, FakeCheckout>();
  private readonly subscriptions = new Map<string, FakeSubscription>();
  private counter = 0;

  constructor(
    private readonly options: {
      secret: string;
      /** Where the hosted checkout page is served (this server's public origin). */
      baseUrl: () => string;
      clock: Clock;
      /** Webhook delivery (production processors POST over HTTPS; here an in-process call). */
      deliver: (body: Buffer, headers: Record<string, string>) => Promise<void>;
      onDeliveryError?: (error: unknown) => void;
    },
  ) {}

  // --- PaymentProcessor ---------------------------------------------------------------------------

  async createCheckout(input: { checkoutId: string; pkg: PackageRecord; price: CheckoutPrice; trialDays: number; successUrl: string; cancelUrl: string }): Promise<{ ref: string; redirectUrl: string }> {
    const ref = `fcs_${randomBytes(9).toString('base64url')}`;
    this.checkouts.set(ref, { ref, pkg: input.pkg, price: input.price, trialDays: input.trialDays, successUrl: input.successUrl, cancelUrl: input.cancelUrl, status: 'open', subscriptionRef: null });
    return { ref, redirectUrl: `${this.options.baseUrl()}/billing/fake-checkout/${ref}` };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProcessorEvent {
    const given = headers[SIGNATURE_HEADER];
    const signature = Buffer.from(typeof given === 'string' ? given : '');
    const expected = Buffer.from(this.sign(rawBody));
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new WebhookSignatureError();
    const parsed = JSON.parse(rawBody.toString('utf8'), (key, value: unknown) => (typeof value === 'string' && /At$|^periodStart$|^periodEnd$|^currentPeriod(Start|End)$/.test(key) ? new Date(value) : value)) as ProcessorEvent;
    // (refundedAt etc. revive as dates through the same rule.)
    return parsed;
  }

  async fetchCheckout(ref: string): Promise<{ status: 'open' | 'paid' | 'expired'; subscription: ProcessorSubscription | null }> {
    const checkout = this.checkouts.get(ref);
    if (!checkout) return { status: 'expired', subscription: null };
    return { status: checkout.status, subscription: checkout.subscriptionRef ? this.snapshot(checkout.subscriptionRef) : null };
  }

  async fetchSubscription(ref: string): Promise<ProcessorSubscription | null> {
    return this.subscriptions.has(ref) ? this.snapshot(ref) : null;
  }

  async cancelSubscription(ref: string, atPeriodEnd: boolean): Promise<void> {
    const subscription = this.require(ref);
    if (atPeriodEnd) {
      subscription.cancelAtPeriodEnd = true;
      this.emit('subscription.updated', subscription, null, null);
    } else {
      subscription.status = 'canceled';
      this.emit('subscription.canceled', subscription, null, null);
    }
  }

  async resumeSubscription(ref: string): Promise<void> {
    const subscription = this.require(ref);
    subscription.cancelAtPeriodEnd = false;
    this.emit('subscription.updated', subscription, null, null);
  }

  async changePlan(ref: string, input: { pkg: PackageRecord; price: { amountMinor: number; currency: string }; dueNowMinor: number; carryMinor: number }): Promise<void> {
    const subscription = this.require(ref);
    if (subscription.status === 'canceled') throw new Error('Subscription is canceled');
    subscription.pkg = input.pkg;
    subscription.price = input.price;
    subscription.credit += input.carryMinor;
    if (input.dueNowMinor > 0 && subscription.currentPeriodStart && subscription.currentPeriodEnd) {
      // The difference for the rest of the period, charged now (the period itself does not move).
      const invoice: ProcessorInvoice = { ref: `fin_${randomBytes(9).toString('base64url')}`, amountMinor: input.dueNowMinor, currency: input.price.currency, periodStart: this.options.clock.now(), periodEnd: subscription.currentPeriodEnd, paidAt: this.options.clock.now() };
      subscription.latestInvoice = invoice;
    }
    this.emit('subscription.updated', subscription, null, null);
  }

  /** The recurring price the processor will charge next (tests). */
  priceOf(ref: string): { amountMinor: number; currency: string; credit: number } {
    const subscription = this.require(ref);
    return { ...subscription.price, credit: subscription.credit };
  }

  async refundLatestInvoice(subscriptionRef: string): Promise<void> {
    const subscription = this.require(subscriptionRef);
    if (!subscription.latestInvoice) throw new Error('Nothing to refund');
    if (subscription.latestInvoice.refundedAt) throw new Error('Already refunded');
    subscription.latestInvoice = { ...subscription.latestInvoice, refundedAt: this.options.clock.now() };
    subscription.status = 'canceled';
    this.emit('charge.refunded', subscription, subscription.latestInvoice, null);
  }

  // --- the hosted checkout page / processor-side actions -------------------------------------------

  checkout(ref: string): FakeCheckout | null {
    return this.checkouts.get(ref) ?? null;
  }

  /** The customer pays on the hosted page; returns where the browser goes next. */
  pay(ref: string): string {
    const checkout = this.checkouts.get(ref);
    if (!checkout || checkout.status !== 'open') throw new Error('Checkout is not open');
    const now = this.options.clock.now();
    const subscriptionRef = `fsub_${randomBytes(9).toString('base64url')}`;
    const trial = checkout.trialDays > 0;
    const periodEnd = trial ? null : addPeriod(now, checkout.pkg.billingPeriod);
    // A promo discounts the first payment (after a trial: the first renewal).
    const invoice = trial ? null : this.invoice(checkout.price.amountMinor - checkout.price.firstDiscountMinor, checkout.price.currency, now, periodEnd!);
    const subscription: FakeSubscription = {
      ref: subscriptionRef,
      pkg: checkout.pkg,
      price: { amountMinor: checkout.price.amountMinor, currency: checkout.price.currency },
      credit: trial ? -checkout.price.firstDiscountMinor : 0,
      status: trial ? 'trialing' : 'active',
      trialEndsAt: trial ? new Date(now.getTime() + checkout.trialDays * 86_400_000) : null,
      currentPeriodStart: trial ? null : now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      latestInvoice: invoice,
    };
    this.subscriptions.set(subscriptionRef, subscription);
    checkout.status = 'paid';
    checkout.subscriptionRef = subscriptionRef;
    this.emit('checkout.completed', subscription, invoice, ref);
    return checkout.successUrl;
  }

  abandon(ref: string): string {
    const checkout = this.checkouts.get(ref);
    if (!checkout) throw new Error('Unknown checkout');
    return checkout.cancelUrl;
  }

  /** The next billing cycle: charge the card (or fail to). */
  renew(subscriptionRef: string, options: { fail?: boolean } = {}): void {
    const subscription = this.require(subscriptionRef);
    const from = subscription.currentPeriodEnd ?? subscription.trialEndsAt ?? this.options.clock.now();
    if (options.fail) {
      subscription.status = 'past_due';
      this.emit('invoice.payment_failed', subscription, null, null);
      return;
    }
    const periodEnd = addPeriod(from, subscription.pkg.billingPeriod);
    subscription.status = 'active';
    subscription.currentPeriodStart = from;
    subscription.currentPeriodEnd = periodEnd;
    // Credit (a downgrade) is used up first; a negative credit is a promo still owed on a trial's first renewal.
    const amount = Math.max(0, subscription.price.amountMinor - subscription.credit);
    subscription.credit = Math.max(0, subscription.credit - subscription.price.amountMinor);
    subscription.latestInvoice = this.invoice(amount, subscription.price.currency, from, periodEnd);
    this.emit('invoice.paid', subscription, subscription.latestInvoice, null);
  }

  /** The subscription of a checkout (for tests and the lab). */
  subscriptionOf(checkoutRef: string): string | null {
    return this.checkouts.get(checkoutRef)?.subscriptionRef ?? null;
  }

  /** A correctly signed webhook body for an arbitrary event (tests: replay, ordering). */
  signed(event: ProcessorEvent): { body: Buffer; headers: Record<string, string> } {
    const body = Buffer.from(JSON.stringify(event));
    return { body, headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: this.sign(body) } };
  }

  lastEvent: ProcessorEvent | null = null;

  // ---------------------------------------------------------------------------------------------

  private invoice(amountMinor: number, currency: string, periodStart: Date, periodEnd: Date): ProcessorInvoice {
    return { ref: `fin_${randomBytes(9).toString('base64url')}`, amountMinor, currency, periodStart, periodEnd, paidAt: this.options.clock.now() };
  }

  private emit(type: ProcessorEventType, subscription: FakeSubscription, invoice: ProcessorInvoice | null, checkoutRef: string | null): void {
    const event: ProcessorEvent = {
      id: `evt_${++this.counter}_${randomBytes(6).toString('base64url')}`,
      type,
      occurredAt: this.options.clock.now(),
      checkoutRef,
      subscription: this.snapshot(subscription.ref),
      invoice,
    };
    this.lastEvent = event;
    const { body, headers } = this.signed(event);
    // Asynchronous, like the real thing: the browser is usually back before the webhook lands.
    setImmediate(() => void this.options.deliver(body, headers).catch((error: unknown) => this.options.onDeliveryError?.(error)));
  }

  private snapshot(ref: string): ProcessorSubscription {
    const { pkg: _pkg, price: _price, credit: _credit, ...subscription } = this.require(ref);
    return structuredClone(subscription);
  }

  private require(ref: string): FakeSubscription {
    const subscription = this.subscriptions.get(ref);
    if (!subscription) throw new Error('Unknown subscription');
    return subscription;
  }

  private sign(body: Buffer): string {
    return createHmac('sha256', this.options.secret).update(body).digest('hex');
  }
}

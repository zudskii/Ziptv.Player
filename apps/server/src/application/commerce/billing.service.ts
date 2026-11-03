import type { CheckoutStartedDto, CheckoutStatusDto, PackageOfferDto, SubscriptionDto } from '@ziptv/contracts';

import { accessUntil, applySubscriptionEvent, isTerminal, startSubscription, type DunningPolicy, type SubscriptionEvent, type SubscriptionState } from '../../domain/commerce/subscription.js';
import { AppError } from '../errors.js';
import type { Viewer } from '../identity/viewer.js';
import type { Clock } from '../ports/clock.js';
import { WebhookSignatureError, type CommerceRepository, type PackageRecord, type PaymentProcessor, type ProcessorEvent, type ProcessorSubscription, type SubscriptionRecord } from '../ports/commerce.js';
import type { Logger } from '../ports/logger.js';

export const SUBSCRIPTION_CHANGED = 'billing.subscription_changed';
/** Outbox: dunning gave up locally — stop the processor from charging further. */
export const CANCEL_AT_PROCESSOR = 'billing.cancel_at_processor';
/** Outbox: a processor subscription ZIPTV will not honour (paid twice, trial reused, paid after cancel) — cancel and refund it. */
export const VOID_AT_PROCESSOR = 'billing.void_at_processor';
const CHECKOUT_VERIFY_AFTER_MS = 10 * 60_000;
const CHECKOUT_EXPIRE_AFTER_MS = 24 * 3600_000;

/**
 * Subscriptions and payments (ZP-ENT-07). Money facts come from the processor only — a verified
 * webhook or the processor's answer to a status query — never from the browser returning from
 * the checkout page. Every webhook is recorded once (`payment_events` is unique per processor
 * event): replays are acknowledged and ignored; a processing failure rolls back the record too,
 * so the processor's retry is processed again.
 */
export class BillingService {
  constructor(
    private readonly deps: {
      commerce: CommerceRepository;
      processor: PaymentProcessor;
      clock: Clock;
      logger: Logger;
      dunning: DunningPolicy;
    },
  ) {}

  // --- viewer --------------------------------------------------------------------------------------

  async offers(viewer: Viewer): Promise<PackageOfferDto[]> {
    const [packages, hadTrial] = await Promise.all([this.deps.commerce.listPackages('active'), this.deps.commerce.hadTrial(viewer.userId)]);
    return packages.map((pkg) => ({
      id: pkg.id,
      slug: pkg.slug,
      name: pkg.name,
      description: pkg.description,
      priceMinor: pkg.priceMinor,
      currency: pkg.currency,
      billingPeriod: pkg.billingPeriod,
      trialDays: hadTrial ? 0 : pkg.trialDays,
      maxDevices: pkg.maxDevices,
      maxStreams: pkg.maxStreams,
      channels: pkg.channels,
    }));
  }

  async startCheckout(viewer: Viewer, packageId: string, returnBase: string): Promise<CheckoutStartedDto> {
    const { commerce, processor, clock } = this.deps;
    const account = await commerce.account(viewer.userId);
    if (!account?.email) throw new AppError('ACCOUNT_REQUIRED', 403, 'Create an account (or sign in) to subscribe.');
    if (account.blockedAt) throw new AppError('FORBIDDEN', 403, 'This account cannot make purchases. Contact support.');
    const pkg = await commerce.findPackage(packageId);
    if (!pkg || pkg.status !== 'active') throw AppError.notFound('Package');
    if (await commerce.liveSubscription(viewer.userId)) throw new AppError('ALREADY_SUBSCRIBED', 409, 'You already have a subscription. Manage it from your account.');

    const trialDays = pkg.trialDays > 0 && !(await commerce.hadTrial(viewer.userId)) ? pkg.trialDays : 0;
    const id = commerce.newId();
    await commerce.createCheckout({ id, userId: viewer.userId, packageId: pkg.id, processor: processor.name, processorRef: null, withTrial: trialDays > 0 }, clock.now());
    const started = await processor.createCheckout({
      checkoutId: id,
      userId: viewer.userId,
      email: account.email,
      pkg,
      trialDays,
      successUrl: `${returnBase}/billing/return?checkout=${id}`,
      cancelUrl: `${returnBase}/plans?canceled=1`,
    });
    await commerce.setCheckoutRef(id, started.ref);
    this.deps.logger.info({ userId: viewer.userId, checkoutId: id, package: pkg.slug, trialDays }, 'Checkout started');
    return { checkoutId: id, redirectUrl: started.redirectUrl };
  }

  /**
   * The viewer is back from the processor. Still nothing is granted on that basis: if no webhook
   * has completed the checkout yet, ask the processor itself, and only its answer counts.
   */
  async checkoutStatus(viewer: Viewer, checkoutId: string): Promise<CheckoutStatusDto> {
    let checkout = await this.deps.commerce.findCheckout(checkoutId);
    if (!checkout || checkout.userId !== viewer.userId) throw AppError.notFound('Checkout');
    if (checkout.status === 'open' && checkout.processorRef) {
      await this.verifyCheckout(checkout.processorRef);
      checkout = (await this.deps.commerce.findCheckout(checkoutId))!;
    }
    const subscription = checkout.subscriptionId ? await this.deps.commerce.findSubscription(checkout.subscriptionId) : null;
    return { checkoutId, status: checkout.status, subscription: subscription ? await this.toDto(subscription) : null };
  }

  async current(viewer: Viewer): Promise<SubscriptionDto | null> {
    const subscription = await this.deps.commerce.liveSubscription(viewer.userId);
    return subscription ? this.toDto(subscription) : null;
  }

  /** Cancel at the end of the paid period (access continues until then). */
  async cancel(viewer: Viewer): Promise<SubscriptionDto> {
    const subscription = await this.requireLive(viewer.userId);
    if (subscription.cancelAtPeriodEnd) return this.toDto(subscription);
    // In dunning there is no paid period left to run out: cancel now, or the processor keeps
    // retrying the open invoice after access has ended.
    const atPeriodEnd = subscription.status === 'trialing' || subscription.status === 'active';
    await this.deps.processor.cancelSubscription(subscription.processorRef, atPeriodEnd);
    // Applied now (the processor accepted it); its webhook confirms it idempotently.
    return this.toDto(await this.applyEvents(subscription.id, [{ type: 'cancel_requested', at: this.deps.clock.now(), atPeriodEnd }], 'viewer'));
  }

  async resume(viewer: Viewer): Promise<SubscriptionDto> {
    const subscription = await this.requireLive(viewer.userId);
    if (!subscription.cancelAtPeriodEnd) return this.toDto(subscription);
    await this.deps.processor.resumeSubscription(subscription.processorRef);
    return this.toDto(await this.applyEvents(subscription.id, [{ type: 'cancel_withdrawn', at: this.deps.clock.now() }], 'viewer'));
  }

  // --- staff (audited by the caller) ----------------------------------------------------------------

  async refund(userId: string): Promise<void> {
    const subscription = await this.requireLive(userId);
    // The processor refunds; its `charge.refunded` webhook revokes access (single source of truth).
    await this.deps.processor.refundLatestInvoice(subscription.processorRef);
  }

  async cancelNow(userId: string): Promise<SubscriptionDto> {
    const subscription = await this.requireLive(userId);
    await this.deps.processor.cancelSubscription(subscription.processorRef, false);
    return this.toDto(await this.applyEvents(subscription.id, [{ type: 'cancel_requested', at: this.deps.clock.now(), atPeriodEnd: false }], 'staff'));
  }

  // --- processor → ZIPTV -----------------------------------------------------------------------------

  /** `POST /billing/webhooks/:processor`. Returns what happened (for logs and the response). */
  async handleWebhook(processorName: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (processorName !== this.deps.processor.name) throw AppError.notFound('Webhook');
    let event: ProcessorEvent;
    try {
      event = this.deps.processor.parseWebhook(rawBody, headers);
    } catch (error) {
      if (error instanceof WebhookSignatureError) throw new AppError('FORBIDDEN', 400, 'Invalid webhook signature.');
      throw AppError.validation('Unreadable webhook.');
    }
    const result = await this.deps.commerce.transaction(async (tx) => {
      const now = this.deps.clock.now();
      const { duplicate } = await tx.recordPaymentEvent({ id: tx.newId(), processor: processorName, eventId: event.id, type: event.type, payload: event, now });
      if (duplicate) return 'duplicate' as const;
      const outcome = await this.process(tx, event, now);
      await tx.markPaymentEvent(processorName, event.id, outcome, now);
      return outcome === 'ignored' ? ('ignored' as const) : ('processed' as const);
    });
    this.deps.logger.info({ processor: processorName, eventId: event.id, type: event.type, result }, 'Payment webhook');
    return result;
  }

  /** The processor's word on a checkout (return page, reconciliation): completes it if paid. */
  async verifyCheckout(processorRef: string): Promise<void> {
    const answer = await this.deps.processor.fetchCheckout(processorRef);
    if (answer.status !== 'paid' || !answer.subscription) return;
    const subscription = answer.subscription;
    await this.deps.commerce.transaction((tx) =>
      this.process(tx, { id: `verify:${processorRef}`, type: 'checkout.completed', occurredAt: this.deps.clock.now(), checkoutRef: processorRef, subscription, invoice: subscription.latestInvoice }, this.deps.clock.now()),
    );
  }

  // --- jobs ------------------------------------------------------------------------------------------

  /** Time-based transitions (trial/period end → dunning → expiry). */
  async runClock(limit = 200): Promise<number> {
    const due = await this.deps.commerce.dueSubscriptions(this.deps.clock.now(), limit);
    let changed = 0;
    for (const id of due) {
      try {
        const before = await this.deps.commerce.findSubscription(id);
        const after = await this.applyEvents(id, [{ type: 'tick', at: this.deps.clock.now() }], 'clock');
        if (before && after.status !== before.status) changed++;
      } catch (error) {
        this.deps.logger.error({ err: error, subscriptionId: id }, 'Subscription clock failed');
      }
    }
    return changed;
  }

  /**
   * Drift repair: a lost webhook must not leave someone without the access they paid for (or with
   * access they no longer pay for). Compares live subscriptions with the processor; finishes paid
   * checkouts whose webhook never arrived; expires abandoned ones.
   */
  async reconcile(options: { olderThanMs: number; limit: number }): Promise<{ subscriptions: number; checkouts: number }> {
    const now = this.deps.clock.now();
    let subscriptions = 0;
    for (const local of await this.deps.commerce.subscriptionsToReconcile(new Date(now.getTime() - options.olderThanMs), options.limit)) {
      try {
        const remote = await this.deps.processor.fetchSubscription(local.processorRef);
        if (remote) {
          const after = await this.deps.commerce.transaction(async (tx) => {
            const locked = await tx.findSubscription(local.id, { lock: true });
            // Changed since the processor was asked (a cancel, a webhook): that snapshot may be
            // older than the change. The next round compares again.
            if (!locked || locked.updatedAt.getTime() !== local.updatedAt.getTime()) return null;
            return this.syncWithProcessor(tx, locked, remote, this.deps.clock.now(), 'reconcile');
          });
          if (after && after.status !== local.status) subscriptions++;
        }
        await this.deps.commerce.markReconciled(local.id, this.deps.clock.now());
      } catch (error) {
        this.deps.logger.warn({ err: error, subscriptionId: local.id }, 'Reconciliation failed for a subscription');
      }
    }
    let checkouts = 0;
    for (const checkout of await this.deps.commerce.openCheckouts(new Date(now.getTime() - CHECKOUT_VERIFY_AFTER_MS), options.limit)) {
      try {
        if (checkout.processorRef) await this.verifyCheckout(checkout.processorRef);
        const current = await this.deps.commerce.findCheckout(checkout.id);
        if (current?.status === 'completed') checkouts++;
        else if (now.getTime() - checkout.createdAt.getTime() > CHECKOUT_EXPIRE_AFTER_MS) await this.deps.commerce.expireCheckout(checkout.id);
      } catch (error) {
        this.deps.logger.warn({ err: error, checkoutId: checkout.id }, 'Checkout verification failed');
      }
    }
    return { subscriptions, checkouts };
  }

  // ---------------------------------------------------------------------------------------------

  private async process(tx: CommerceRepository, event: ProcessorEvent, now: Date): Promise<string> {
    const processor = this.deps.processor.name;
    let subscription = await tx.findSubscriptionByRef(processor, event.subscription.ref, { lock: true });

    if (!subscription) {
      // A first event for this subscription: it must belong to one of our checkouts.
      const checkout = event.checkoutRef ? await tx.findCheckoutByRef(processor, event.checkoutRef, { lock: true }) : null;
      if (!checkout) return 'ignored: unknown subscription';
      if (checkout.status === 'completed') return 'ignored: checkout already completed';
      // One account at a time: two checkouts completing together cannot both pass the checks below.
      await tx.lockAccount(checkout.userId);
      const reject = async (reason: string): Promise<string> => {
        // ZIPTV will not honour it: the processor cancels it and refunds anything collected.
        this.deps.logger.warn({ checkoutId: checkout.id, userId: checkout.userId, subscriptionRef: event.subscription.ref, reason }, 'Processor subscription voided');
        await tx.enqueue(VOID_AT_PROCESSOR, { userId: checkout.userId, checkoutId: checkout.id, subscriptionRef: event.subscription.ref, reason }, now);
        // Closed, so the return page and reconciliation stop processing it again.
        if (checkout.status === 'open') await tx.expireCheckout(checkout.id);
        return `voided: ${reason}`;
      };
      // (An expired checkout that got paid anyway is still honoured when nothing conflicts.)
      if (await tx.liveSubscription(checkout.userId, { lock: true })) return reject('live subscription exists');
      if (event.subscription.status === 'trialing' && (!checkout.withTrial || (await tx.hadTrial(checkout.userId)))) return reject('trial already used');
      const initial = initialState(event.subscription, now);
      if (!initial) return 'ignored: processor subscription not usable';
      subscription = await tx.createSubscription({ id: tx.newId(), userId: checkout.userId, packageId: checkout.packageId, processor, processorRef: event.subscription.ref, ...initial }, now);
      await tx.completeCheckout(checkout.id, subscription.id, now);
      await this.recordInvoice(tx, subscription, event.invoice);
      await this.afterChange(tx, null, subscription, now, 'checkout');
      return `created: ${subscription.status}`;
    }

    switch (event.type) {
      case 'invoice.paid': {
        if (!event.invoice) return 'ignored: no invoice';
        await this.recordInvoice(tx, subscription, event.invoice);
        if (isTerminal(subscription.status)) {
          // Collected for a subscription that has ended for good (a retry that raced the
          // cancellation sent when dunning expired it): give the money back.
          await tx.enqueue(VOID_AT_PROCESSOR, { userId: subscription.userId, subscriptionRef: subscription.processorRef, reason: `paid while ${subscription.status}` }, now);
          return `voided: paid while ${subscription.status}`;
        }
        const after = await this.applyIn(tx, subscription, [{ type: 'payment_succeeded', at: event.occurredAt, periodStart: event.invoice.periodStart, periodEnd: event.invoice.periodEnd }], now, 'webhook');
        return `status: ${after.status}`;
      }
      case 'invoice.payment_failed':
        return `status: ${(await this.applyIn(tx, subscription, [{ type: 'payment_failed', at: event.occurredAt }], now, 'webhook')).status}`;
      case 'charge.refunded':
        if (event.invoice) await tx.refundInvoice(processor, event.invoice.ref, now);
        // An older period refunded (goodwill, a dispute): the current paid period stands.
        if (event.invoice && subscription.currentPeriodEnd && event.invoice.periodEnd < subscription.currentPeriodEnd) return 'invoice refunded';
        return `status: ${(await this.applyIn(tx, subscription, [{ type: 'refunded', at: event.occurredAt }], now, 'webhook')).status}`;
      case 'subscription.canceled':
        return `status: ${(await this.applyIn(tx, subscription, [{ type: 'cancel_requested', at: event.occurredAt, atPeriodEnd: false }], now, 'webhook')).status}`;
      case 'checkout.completed':
      case 'subscription.updated':
        return `status: ${(await this.syncWithProcessor(tx, subscription, event.subscription, now, 'webhook')).status}`;
    }
  }

  /** Brings a local subscription in line with the processor's snapshot (idempotent). */
  private async syncWithProcessor(tx: CommerceRepository, local: SubscriptionRecord, remote: ProcessorSubscription, now: Date, source: string): Promise<SubscriptionRecord> {
    const events: SubscriptionEvent[] = [];
    if (remote.latestInvoice) {
      await this.recordInvoice(tx, local, remote.latestInvoice);
      events.push({ type: 'payment_succeeded', at: remote.latestInvoice.paidAt, periodStart: remote.latestInvoice.periodStart, periodEnd: remote.latestInvoice.periodEnd });
    }
    if (remote.status === 'canceled') events.push({ type: 'cancel_requested', at: now, atPeriodEnd: false });
    else if (remote.cancelAtPeriodEnd && !local.cancelAtPeriodEnd) events.push({ type: 'cancel_requested', at: now, atPeriodEnd: true });
    else if (!remote.cancelAtPeriodEnd && local.cancelAtPeriodEnd) events.push({ type: 'cancel_withdrawn', at: now });
    if (remote.status === 'past_due') events.push({ type: 'payment_failed', at: now });
    events.push({ type: 'tick', at: now });
    return this.applyIn(tx, local, events, now, source);
  }

  private async applyEvents(subscriptionId: string, events: SubscriptionEvent[], source: string): Promise<SubscriptionRecord> {
    return this.deps.commerce.transaction(async (tx) => {
      const subscription = await tx.findSubscription(subscriptionId, { lock: true });
      if (!subscription) throw AppError.notFound('Subscription');
      return this.applyIn(tx, subscription, events, this.deps.clock.now(), source);
    });
  }

  private async applyIn(tx: CommerceRepository, subscription: SubscriptionRecord, events: SubscriptionEvent[], now: Date, source: string): Promise<SubscriptionRecord> {
    let state: SubscriptionState = subscription;
    for (const event of events) {
      const transition = applySubscriptionEvent(state, event, this.deps.dunning);
      if (transition.ignored) this.deps.logger.debug({ subscriptionId: subscription.id, event: event.type, reason: transition.ignored }, 'Subscription event ignored');
      state = transition.state;
    }
    const after: SubscriptionRecord = { ...subscription, ...pick(state) };
    if (JSON.stringify(pick(state)) !== JSON.stringify(pick(subscription))) {
      await tx.saveSubscription(after, now);
      await this.afterChange(tx, subscription, after, now, source);
    }
    return after;
  }

  /** Entitlement mirrors the subscription; the viewer is told about status changes. */
  private async afterChange(tx: CommerceRepository, before: SubscriptionRecord | null, after: SubscriptionRecord, now: Date, source: string): Promise<void> {
    await tx.syncSubscriptionEntitlement({
      subscriptionId: after.id,
      userId: after.userId,
      packageId: after.packageId,
      startsAt: after.createdAt,
      endsAt: accessUntil(after, this.deps.dunning) ?? now,
      revoked: isTerminal(after.status),
      now,
    });
    if (after.status === 'expired' && before?.status !== 'expired') {
      await tx.enqueue(CANCEL_AT_PROCESSOR, { subscriptionId: after.id, subscriptionRef: after.processorRef }, now);
    }
    if (!before || before.status !== after.status || before.cancelAtPeriodEnd !== after.cancelAtPeriodEnd) {
      await tx.enqueue(SUBSCRIPTION_CHANGED, { userId: after.userId, subscriptionId: after.id, from: before?.status ?? null, to: after.status, cancelAtPeriodEnd: after.cancelAtPeriodEnd }, now);
      this.deps.logger.info({ subscriptionId: after.id, userId: after.userId, from: before?.status ?? null, to: after.status, source }, 'Subscription changed');
    }
  }

  private async recordInvoice(tx: CommerceRepository, subscription: SubscriptionRecord, invoice: ProcessorEvent['invoice']): Promise<void> {
    if (!invoice) return;
    await tx.recordInvoice({
      id: tx.newId(),
      userId: subscription.userId,
      subscriptionId: subscription.id,
      processor: subscription.processor,
      processorRef: invoice.ref,
      amountMinor: invoice.amountMinor,
      currency: invoice.currency,
      status: 'paid',
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      paidAt: invoice.paidAt,
      refundedAt: null,
    });
  }

  // --- outbox handlers (idempotent: they may run more than once) -------------------------------------

  /** Dunning expired the subscription: make sure the processor stops charging. */
  async cancelAtProcessor(subscriptionRef: string): Promise<void> {
    const remote = await this.deps.processor.fetchSubscription(subscriptionRef);
    if (!remote || remote.status === 'canceled') return;
    await this.deps.processor.cancelSubscription(subscriptionRef, false);
    this.deps.logger.info({ subscriptionRef }, 'Canceled at the processor after dunning expired it');
  }

  /** A subscription ZIPTV does not honour: refund what was collected, then cancel it. */
  async voidAtProcessor(subscriptionRef: string, reason: string): Promise<void> {
    const remote = await this.deps.processor.fetchSubscription(subscriptionRef);
    if (!remote) return;
    if (remote.latestInvoice && !remote.latestInvoice.refundedAt) await this.deps.processor.refundLatestInvoice(subscriptionRef);
    const after = await this.deps.processor.fetchSubscription(subscriptionRef);
    if (after && after.status !== 'canceled') await this.deps.processor.cancelSubscription(subscriptionRef, false);
    this.deps.logger.warn({ subscriptionRef, reason }, 'Voided a processor subscription (refunded and canceled)');
  }

  private async requireLive(userId: string): Promise<SubscriptionRecord> {
    const subscription = await this.deps.commerce.liveSubscription(userId);
    if (!subscription) throw AppError.notFound('Subscription');
    return subscription;
  }

  async toDto(subscription: SubscriptionRecord, pkg?: PackageRecord | null): Promise<SubscriptionDto> {
    const owned = pkg ?? (await this.deps.commerce.findPackage(subscription.packageId));
    const until = accessUntil(subscription, this.deps.dunning);
    return {
      id: subscription.id,
      status: subscription.status,
      package: { id: subscription.packageId, slug: owned?.slug ?? '', name: owned?.name ?? '' },
      trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      accessUntil: until?.toISOString() ?? null,
    };
  }
}

function pick(state: SubscriptionState): SubscriptionState {
  return {
    status: state.status,
    trialEndsAt: state.trialEndsAt,
    currentPeriodStart: state.currentPeriodStart,
    currentPeriodEnd: state.currentPeriodEnd,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    endedAt: state.endedAt,
  };
}

/** A new local subscription from the processor's snapshot (a trial, or a paid first period). */
function initialState(remote: ProcessorSubscription, now: Date): SubscriptionState | null {
  try {
    if (remote.status === 'trialing' && remote.trialEndsAt) return startSubscription({ at: now, trialEndsAt: remote.trialEndsAt });
    const invoice = remote.latestInvoice;
    if (remote.status === 'active' && invoice) return startSubscription({ at: now, periodStart: invoice.periodStart, periodEnd: invoice.periodEnd });
  } catch {
    return null;
  }
  return null;
}

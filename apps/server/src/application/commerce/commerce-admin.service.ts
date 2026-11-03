import type { CompEntitlementRequest, CreatePackageRequest, EntitlementDto, PackageDetailDto, PackageDto, PaymentEventDto, UpdatePackageRequest, UserBillingDto } from '@ziptv/contracts';

import { stateHash } from '../../domain/admin/audit.js';
import { slugify } from '../../domain/operator/catalog.js';
import { actorOf, type AdminContext, type StaffPrincipal } from '../admin/principal.js';
import { AppError } from '../errors.js';
import type { AdminTransaction, AdminUnitOfWork } from '../ports/admin.js';
import type { Clock } from '../ports/clock.js';
import type { CommerceRepository, PackageRecord } from '../ports/commerce.js';
import type { OperatorCatalogRepository } from '../ports/operator.js';
import type { AccountBillingService } from './account-billing.service.js';
import { toEntitlementDto } from './account-billing.service.js';
import type { BillingService } from './billing.service.js';
import type { PlaybackAuthorizationService } from './playback-authorization.service.js';

/**
 * Console side of commerce: packages (and which channels they carry), a subscriber's billing,
 * comp entitlements, refunds, cancellations, account blocks, the payment event log. Every change
 * is audited; money operations go to the processor first and are confirmed by its webhooks.
 */
export class CommerceAdminService {
  constructor(
    private readonly deps: {
      commerce: CommerceRepository;
      catalog: Pick<OperatorCatalogRepository, 'findChannels'>;
      billing: Pick<BillingService, 'refund' | 'cancelNow' | 'toDto'>;
      accounts: Pick<AccountBillingService, 'summary'>;
      authorization: Pick<PlaybackAuthorizationService, 'endAllOf' | 'revalidate' | 'revalidateChannel'>;
      uow: AdminUnitOfWork;
      clock: Clock;
      /** The channel list's lock annotations changed (packages / channels). */
      onCatalogChange?: () => void;
    },
  ) {}

  // --- packages ------------------------------------------------------------------------------------

  async packages(): Promise<PackageDto[]> {
    return (await this.deps.commerce.listPackages()).map((pkg) => toPackageDto(pkg, pkg.channels));
  }

  async package(id: string): Promise<PackageDetailDto> {
    const pkg = await this.deps.commerce.findPackage(id);
    if (!pkg) throw AppError.notFound('Package');
    const channelIds = await this.deps.commerce.packageChannels(pkg.id);
    return { ...toPackageDto(pkg, channelIds.length), channelIds };
  }

  async createPackage(actor: StaffPrincipal, input: CreatePackageRequest, context: AdminContext): Promise<PackageDetailDto> {
    const record: Omit<PackageRecord, 'createdAt'> = {
      id: this.deps.commerce.newId(),
      slug: slugify(input.slug ?? input.name),
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      priceMinor: input.priceMinor,
      currency: input.currency.toUpperCase(),
      billingPeriod: input.billingPeriod,
      trialDays: input.trialDays ?? 0,
      maxDevices: input.maxDevices,
      maxStreams: input.maxStreams,
      businessModel: input.businessModel ?? 'subscription',
      status: 'draft',
    };
    await this.write(async (tx) => {
      const created = await tx.commerce.createPackage(record);
      await this.audit(tx, actor, context, 'package.created', created.id, null, created, { slug: created.slug });
    }, 'A package with this slug already exists.');
    return this.package(record.id);
  }

  async updatePackage(actor: StaffPrincipal, id: string, input: UpdatePackageRequest, context: AdminContext): Promise<PackageDetailDto> {
    const before = await this.deps.commerce.findPackage(id);
    if (!before) throw AppError.notFound('Package');
    if (input.channelIds) {
      const found = await this.deps.catalog.findChannels(input.channelIds);
      if (found.length !== new Set(input.channelIds).size) throw AppError.validation('The package lists a channel that does not exist.');
    }
    // Price and period of existing subscriptions are the processor's business; changing them here
    // affects new checkouts only.
    let removedChannels: string[] = [];
    await this.write(async (tx) => {
      const { channelIds, ...patch } = input;
      const updated = await tx.commerce.updatePackage(before.id, { ...patch, ...(patch.slug ? { slug: slugify(patch.slug) } : {}), ...(patch.currency ? { currency: patch.currency.toUpperCase() } : {}) });
      const beforeChannels = channelIds ? await tx.commerce.packageChannels(before.id) : null;
      removedChannels = beforeChannels ? beforeChannels.filter((channelId) => !channelIds!.includes(channelId)) : [];
      if (channelIds) await tx.commerce.setPackageChannels(before.id, channelIds);
      await this.audit(tx, actor, context, 'package.updated', before.id, { ...before, channels: beforeChannels }, { ...updated, channels: channelIds ?? null }, { changes: Object.keys(input) });
    }, 'A package with this slug already exists.');
    this.deps.onCatalogChange?.();
    // Viewings a removed channel's package allowed stop now, not at their next heartbeat.
    for (const channelId of removedChannels) await this.deps.authorization.revalidateChannel(channelId);
    return this.package(before.id);
  }

  // --- subscribers ---------------------------------------------------------------------------------

  async userBilling(userId: string): Promise<UserBillingDto> {
    const account = await this.deps.commerce.account(userId);
    if (!account) throw AppError.notFound('User');
    const [summary, subscriptions] = await Promise.all([this.deps.accounts.summary({ userId }), this.deps.commerce.subscriptionsOf(userId)]);
    return {
      ...summary,
      userId,
      email: account.email,
      blocked: account.blockedAt !== null,
      blockedReason: account.blockedReason,
      subscriptions: await Promise.all(subscriptions.map((subscription) => this.deps.billing.toDto(subscription))),
    };
  }

  /** Complimentary / B2B access without payment (an open-ended or dated entitlement). */
  async grantComp(actor: StaffPrincipal, userId: string, input: CompEntitlementRequest, context: AdminContext): Promise<EntitlementDto> {
    if (!(await this.deps.commerce.account(userId))) throw AppError.notFound('User');
    const pkg = await this.deps.commerce.findPackage(input.packageId);
    if (!pkg) throw AppError.notFound('Package');
    const now = this.deps.clock.now();
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    if (endsAt && endsAt <= now) throw AppError.validation('A comp entitlement must end in the future.');
    const created = await this.write(async (tx) => {
      const entitlement = await tx.commerce.createCompEntitlement({ id: tx.commerce.newId(), userId, packageId: pkg.id, startsAt: now, endsAt, note: input.note.trim(), createdBy: actor.id, now });
      await this.audit(tx, actor, context, 'entitlement.granted', entitlement.id, null, entitlement, { userId, package: pkg.slug, endsAt: endsAt?.toISOString() ?? null, note: input.note });
      return entitlement;
    });
    return toEntitlementDto(created, pkg, now);
  }

  async revokeEntitlement(actor: StaffPrincipal, userId: string, entitlementId: string, context: AdminContext): Promise<void> {
    const entitlement = (await this.deps.commerce.entitlementsOf(userId)).find((item) => item.id === entitlementId);
    if (!entitlement) throw AppError.notFound('Entitlement');
    if (entitlement.kind !== 'comp') throw new AppError('CONFLICT', 409, 'A subscription’s entitlement follows the subscription: cancel or refund it instead.');
    await this.write(async (tx) => {
      const revoked = await tx.commerce.revokeEntitlement(entitlementId, this.deps.clock.now());
      if (!revoked) throw new AppError('CONFLICT', 409, 'This entitlement is already revoked.');
      await this.audit(tx, actor, context, 'entitlement.revoked', entitlementId, entitlement, revoked, { userId });
    });
    await this.deps.authorization.revalidate(userId);
  }

  async refund(actor: StaffPrincipal, userId: string, context: AdminContext): Promise<void> {
    await this.deps.billing.refund(userId);
    await this.write((tx) => this.audit(tx, actor, context, 'subscription.refund_requested', userId, null, null, { userId }));
  }

  async cancelNow(actor: StaffPrincipal, userId: string, context: AdminContext): Promise<void> {
    const after = await this.deps.billing.cancelNow(userId);
    await this.write((tx) => this.audit(tx, actor, context, 'subscription.canceled', after.id, null, after, { userId }));
    await this.deps.authorization.revalidate(userId);
  }

  /** Blocks an account: no operator playback (viewings end now), no purchases. */
  async setBlocked(actor: StaffPrincipal, userId: string, input: { blocked: boolean; reason?: string | undefined }, context: AdminContext): Promise<UserBillingDto> {
    const account = await this.deps.commerce.account(userId);
    if (!account) throw AppError.notFound('User');
    await this.write(async (tx) => {
      await tx.commerce.setBlocked(userId, input.blocked, input.reason?.trim() || null, this.deps.clock.now());
      await this.audit(tx, actor, context, input.blocked ? 'user.blocked' : 'user.unblocked', userId, { blocked: account.blockedAt !== null }, { blocked: input.blocked }, { reason: input.reason ?? null });
    });
    if (input.blocked) await this.deps.authorization.endAllOf(userId, 'account_blocked');
    return this.userBilling(userId);
  }

  async paymentEvents(limit: number): Promise<PaymentEventDto[]> {
    return (await this.deps.commerce.paymentEvents(limit)).map((event) => ({
      id: event.id,
      processor: event.processor,
      eventId: event.eventId,
      type: event.type,
      receivedAt: event.receivedAt.toISOString(),
      processedAt: event.processedAt?.toISOString() ?? null,
      outcome: event.outcome,
    }));
  }

  // ---------------------------------------------------------------------------------------------

  private async write<T>(work: (tx: AdminTransaction) => Promise<T>, conflict?: string): Promise<T> {
    try {
      return await this.deps.uow.run(work);
    } catch (error) {
      if (conflict && typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505') throw new AppError('CONFLICT', 409, conflict);
      throw error;
    }
  }

  private async audit(tx: AdminTransaction, actor: StaffPrincipal, context: AdminContext, action: string, targetId: string, before: unknown, after: unknown, details: Record<string, unknown>): Promise<void> {
    const targetType = action.split('.')[0]!;
    await tx.audit.append({ ...actorOf(actor, context), occurredAt: this.deps.clock.now(), action, targetType, targetId, beforeHash: stateHash(before), afterHash: stateHash(after), details });
  }
}

function toPackageDto(pkg: PackageRecord, channels: number): PackageDto {
  return {
    id: pkg.id,
    slug: pkg.slug,
    name: pkg.name,
    description: pkg.description,
    priceMinor: pkg.priceMinor,
    currency: pkg.currency,
    billingPeriod: pkg.billingPeriod,
    trialDays: pkg.trialDays,
    maxDevices: pkg.maxDevices,
    maxStreams: pkg.maxStreams,
    channels,
    businessModel: pkg.businessModel,
    status: pkg.status,
    createdAt: pkg.createdAt.toISOString(),
  };
}

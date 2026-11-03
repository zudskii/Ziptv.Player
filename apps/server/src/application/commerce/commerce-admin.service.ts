import type { ChangeRequestDto, CompEntitlementRequest, CreatePackageRequest, EntitlementDto, PackageDetailDto, PackageDto, PaymentEventDto, UpdatePackageRequest, UserBillingDto } from '@ziptv/contracts';

import { stateHash } from '../../domain/admin/audit.js';
import { slugify } from '../../domain/operator/catalog.js';
import type { ChangeHandler, ChangeRequestService } from '../admin/change-requests.service.js';
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
      changes: Pick<ChangeRequestService, 'propose'>;
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

  /** New package (draft): through four-eyes approval unless it is off. */
  async createPackage(actor: StaffPrincipal, input: CreatePackageRequest, context: AdminContext): Promise<PackageChange> {
    const outcome = await this.deps.changes.propose(actor, 'package.create', null, { ...input }, context);
    return outcome.status === 'pending' ? { status: 'pending', request: outcome.request } : { status: 'applied', package: await this.package(String(outcome.result)) };
  }

  /** Price, limits, status, channels: through four-eyes approval unless it is off. */
  async updatePackage(actor: StaffPrincipal, id: string, input: UpdatePackageRequest, context: AdminContext): Promise<PackageChange> {
    const pkg = await this.deps.commerce.findPackage(id);
    if (!pkg) throw AppError.notFound('Package');
    const outcome = await this.deps.changes.propose(actor, 'package.update', pkg.id, { ...input }, context);
    return outcome.status === 'pending' ? { status: 'pending', request: outcome.request } : { status: 'applied', package: await this.package(pkg.id) };
  }

  /** Four-eyes handlers of package changes (registered with the change request service). */
  changeHandlers(): ChangeHandler[] {
    const commerce = this.deps.commerce;
    const create: ChangeHandler = {
      kind: 'package.create',
      targetType: 'package',
      prepare: async (payload) => {
        const input = payload as unknown as CreatePackageRequest;
        const record = newPackageRecord(input);
        if (await commerce.findPackage(record.slug)) throw new AppError('CONFLICT', 409, 'A package with this slug already exists.');
        return { payload: { ...input, slug: record.slug }, summary: `New package “${record.name}” (${record.slug}, ${record.businessModel}) — ${money(record.priceMinor, record.currency)}/${record.billingPeriod}, ${record.maxStreams} stream(s), ${record.maxDevices} device(s)${record.trialDays ? `, ${record.trialDays}-day trial` : ''}`, base: null };
      },
      apply: async (tx, actor, change, context) => {
        const record = { ...newPackageRecord(change.payload as unknown as CreatePackageRequest), id: tx.commerce.newId() };
        const created = await tx.commerce.createPackage(record);
        await this.audit(tx, actor, context, 'package.created', created.id, null, created, { slug: created.slug, changeRequest: change.requestId, requestedBy: change.requestedBy });
        return { targetId: created.id, result: created.id };
      },
    };
    const update: ChangeHandler = {
      kind: 'package.update',
      targetType: 'package',
      prepare: async (payload, targetId) => {
        const input = payload as unknown as UpdatePackageRequest;
        const before = targetId ? await commerce.findPackage(targetId) : null;
        if (!before) throw AppError.notFound('Package');
        await this.checkChannels(input.channelIds);
        if (input.slug && slugify(input.slug) !== before.slug && (await commerce.findPackage(slugify(input.slug)))) throw new AppError('CONFLICT', 409, 'A package with this slug already exists.');
        const channels = await commerce.packageChannels(before.id);
        // Name the channels that move, so the approver sees what the change does, not just counts.
        const touched = input.channelIds ? [...new Set([...input.channelIds, ...channels])].filter((id) => !input.channelIds!.includes(id) || !channels.includes(id)) : [];
        const names = new Map((touched.length ? await this.deps.catalog.findChannels(touched) : []).map((channel) => [channel.id, channel.name]));
        return { payload: { ...input }, summary: describeUpdate(before, channels, input, names), base: packageState(before, channels) };
      },
      current: async (tx, targetId) => {
        const pkg = await tx.commerce.findPackage(targetId);
        return pkg ? packageState(pkg, await tx.commerce.packageChannels(pkg.id)) : null;
      },
      apply: async (tx, actor, change, context) => {
        const input = change.payload as unknown as UpdatePackageRequest;
        const before = change.targetId ? await tx.commerce.findPackage(change.targetId) : null;
        if (!before) throw AppError.notFound('Package');
        await this.checkChannels(input.channelIds, tx);
        // Price and period of existing subscriptions are the processor's business; changing them
        // here affects new checkouts only.
        const { channelIds, ...patch } = input;
        const updated = await tx.commerce.updatePackage(before.id, { ...patch, ...(patch.slug ? { slug: slugify(patch.slug) } : {}), ...(patch.currency ? { currency: patch.currency.toUpperCase() } : {}) });
        const beforeChannels = await tx.commerce.packageChannels(before.id);
        if (channelIds) await tx.commerce.setPackageChannels(before.id, channelIds);
        await this.audit(tx, actor, context, 'package.updated', before.id, packageState(before, beforeChannels), packageState(updated ?? before, channelIds ?? beforeChannels), {
          changes: Object.keys(input),
          changeRequest: change.requestId,
          requestedBy: change.requestedBy,
        });
        const removed = channelIds ? beforeChannels.filter((channelId) => !channelIds.includes(channelId)) : [];
        return { targetId: before.id, result: removed };
      },
      afterCommit: async (_change, removed) => {
        this.deps.onCatalogChange?.();
        // Viewings a removed channel's package allowed stop now, not at their next heartbeat.
        for (const channelId of removed as string[]) await this.deps.authorization.revalidateChannel(channelId);
      },
    };
    return [create, update];
  }

  private async checkChannels(channelIds: string[] | undefined, tx?: AdminTransaction): Promise<void> {
    if (!channelIds) return;
    const found = await (tx ? tx.catalog : this.deps.catalog).findChannels(channelIds);
    if (found.length !== new Set(channelIds).size) throw AppError.validation('The package lists a channel that does not exist.');
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

export type PackageChange = { status: 'applied'; package: PackageDetailDto } | { status: 'pending'; request: ChangeRequestDto };

function newPackageRecord(input: CreatePackageRequest): Omit<PackageRecord, 'createdAt' | 'id'> {
  return {
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
}

/** What four-eyes compares: the package's sellable terms and its channels (order-free). */
function packageState(pkg: PackageRecord, channels: readonly string[]) {
  const { createdAt: _createdAt, ...terms } = pkg;
  return { ...terms, channels: [...channels].sort() };
}

const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;

/** "Basic: price 9.99 GEL → 12.99 GEL; status draft → active; channels 3 → 5 (+2)". */
function describeUpdate(before: PackageRecord, channels: readonly string[], input: UpdatePackageRequest, names: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  const currency = input.currency?.toUpperCase() ?? before.currency;
  if ((input.priceMinor !== undefined && input.priceMinor !== before.priceMinor) || currency !== before.currency) parts.push(`price ${money(before.priceMinor, before.currency)} → ${money(input.priceMinor ?? before.priceMinor, currency)}`);
  if (input.status && input.status !== before.status) parts.push(`status ${before.status} → ${input.status}`);
  if (input.billingPeriod && input.billingPeriod !== before.billingPeriod) parts.push(`period ${before.billingPeriod} → ${input.billingPeriod}`);
  if (input.trialDays !== undefined && input.trialDays !== before.trialDays) parts.push(`trial ${before.trialDays} → ${input.trialDays} days`);
  if (input.maxStreams !== undefined && input.maxStreams !== before.maxStreams) parts.push(`streams ${before.maxStreams} → ${input.maxStreams}`);
  if (input.maxDevices !== undefined && input.maxDevices !== before.maxDevices) parts.push(`devices ${before.maxDevices} → ${input.maxDevices}`);
  if (input.channelIds) {
    const next = new Set(input.channelIds);
    const added = [...next].filter((id) => !channels.includes(id));
    const removed = channels.filter((id) => !next.has(id));
    const list = (ids: string[]) => {
      const shown = ids.slice(0, 10).map((id) => names.get(id) ?? id);
      return shown.join(', ') + (ids.length > shown.length ? ` and ${ids.length - shown.length} more` : '');
    };
    if (added.length || removed.length) {
      parts.push(`channels ${channels.length} → ${next.size}${added.length ? ` (+ ${list(added)})` : ''}${removed.length ? ` (− ${list(removed)})` : ''}`);
    }
  }
  if (input.name && input.name.trim() !== before.name) parts.push(`name → “${input.name.trim()}”`);
  if (input.description !== undefined && input.description.trim() !== before.description) parts.push('description');
  if (input.slug && slugify(input.slug) !== before.slug) parts.push(`slug → ${slugify(input.slug)}`);
  if (input.businessModel && input.businessModel !== before.businessModel) parts.push(`model ${before.businessModel} → ${input.businessModel}`);
  return `${before.name}: ${parts.length ? parts.join('; ') : 'no effective change'}`;
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

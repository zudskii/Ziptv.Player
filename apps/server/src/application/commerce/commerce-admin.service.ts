import type {
  ChangeRequestDto,
  CompEntitlementRequest,
  CreatePackageRequest,
  CreatePromoRequest,
  EntitlementDto,
  PackageDetailDto,
  PackageDto,
  PaymentEventDto,
  PromoCodeDto,
  ProviderPackageOptionDto,
  RegionalPriceDto,
  UpdatePackageRequest,
  UpdatePromoRequest,
  UserBillingDto,
} from '@ziptv/contracts';

import { stateHash } from '../../domain/admin/audit.js';
import { changedTerms, normalizePromoCode, type RegionalPrice, type VersionedTerm } from '../../domain/commerce/plan.js';
import { isCountryCode, slugify } from '../../domain/operator/catalog.js';
import type { ChangeHandler, ChangeRequestService } from '../admin/change-requests.service.js';
import { actorOf, type AdminContext, type StaffPrincipal } from '../admin/principal.js';
import { AppError } from '../errors.js';
import type { AdminTransaction, AdminUnitOfWork } from '../ports/admin.js';
import type { Clock } from '../ports/clock.js';
import type { CommerceRepository, PackageRecord, PromoCodeRecord } from '../ports/commerce.js';
import type { OperatorCatalogRepository } from '../ports/operator.js';
import type { ProviderFeedRepository } from '../ports/provider-feed-repository.js';
import type { AccountBillingService } from './account-billing.service.js';
import { toEntitlementDto } from './account-billing.service.js';
import type { BillingService } from './billing.service.js';
import type { PlaybackAuthorizationService } from './playback-authorization.service.js';

/**
 * Console side of commerce: plans (their channels, VOD mode, quality, catch-up, regional prices
 * and versions), promo codes, a subscriber's billing, comp entitlements, refunds, cancellations,
 * account blocks, the payment event log. Every change is audited; plan and promo changes go
 * through four-eyes approval; money operations go to the processor first and are confirmed by
 * its webhooks.
 */
export class CommerceAdminService {
  constructor(
    private readonly deps: {
      commerce: CommerceRepository;
      catalog: Pick<OperatorCatalogRepository, 'findChannels'>;
      feeds: Pick<ProviderFeedRepository, 'packageOptions'>;
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
    const packages = await this.deps.commerce.listPackages();
    const ids = packages.map((pkg) => pkg.id);
    const [prices, holders] = await Promise.all([this.deps.commerce.packagePrices(ids), this.deps.commerce.packageHolders(ids, this.deps.clock.now())]);
    return packages.map((pkg) => toPackageDto(pkg, pkg.channels, prices.get(pkg.id) ?? [], holders.get(pkg.id) ?? 0));
  }

  async package(id: string): Promise<PackageDetailDto> {
    const pkg = await this.deps.commerce.findPackage(id);
    if (!pkg) throw AppError.notFound('Package');
    const [channelIds, family, prices] = await Promise.all([this.deps.commerce.packageChannels(pkg.id), this.deps.commerce.packageFamily(pkg.familyId), this.deps.commerce.packagePrices([pkg.id])]);
    const holders = await this.deps.commerce.packageHolders(family.map((item) => item.id), this.deps.clock.now());
    return {
      ...toPackageDto(pkg, channelIds.length, prices.get(pkg.id) ?? [], holders.get(pkg.id) ?? 0),
      channelIds,
      versions: family.map((item) => ({ id: item.id, version: item.version, status: item.status, priceMinor: item.priceMinor, currency: item.currency, holders: holders.get(item.id) ?? 0, createdAt: item.createdAt.toISOString() })),
    };
  }

  /** Vendor packages a VOD plan can open. */
  async providerPackages(): Promise<ProviderPackageOptionDto[]> {
    return this.deps.feeds.packageOptions();
  }

  /** New package (draft): through four-eyes approval unless it is off. */
  async createPackage(actor: StaffPrincipal, input: CreatePackageRequest, context: AdminContext): Promise<PackageChange> {
    const outcome = await this.deps.changes.propose(actor, 'package.create', null, { ...input }, context);
    return outcome.status === 'pending' ? { status: 'pending', request: outcome.request } : { status: 'applied', package: await this.package(String(outcome.result)) };
  }

  /**
   * Price, limits, entitlements, status, channels: through four-eyes approval unless it is off.
   * When the plan's terms change while people hold it, the change becomes a new version and the
   * holders keep theirs; the result is then the new version.
   */
  async updatePackage(actor: StaffPrincipal, id: string, input: UpdatePackageRequest, context: AdminContext): Promise<PackageChange> {
    const pkg = await this.deps.commerce.findPackage(id);
    if (!pkg) throw AppError.notFound('Package');
    const outcome = await this.deps.changes.propose(actor, 'package.update', pkg.id, { ...input }, context);
    return outcome.status === 'pending' ? { status: 'pending', request: outcome.request } : { status: 'applied', package: await this.package((outcome.result as PackageUpdateResult).packageId) };
  }

  /** Four-eyes handlers of package and promo changes (registered with the change request service). */
  changeHandlers(): ChangeHandler[] {
    const commerce = this.deps.commerce;
    const create: ChangeHandler = {
      kind: 'package.create',
      targetType: 'package',
      prepare: async (payload) => {
        const input = payload as unknown as CreatePackageRequest;
        const record = newPackageRecord(input);
        await this.checkTerms(record, input.prices);
        if (await commerce.findPackage(record.slug)) throw new AppError('CONFLICT', 409, 'A package with this slug already exists.');
        return { payload: { ...input, slug: record.slug }, summary: describeCreate(record, input.prices ?? []), base: null };
      },
      apply: async (tx, actor, change, context) => {
        const input = change.payload as unknown as CreatePackageRequest;
        const id = tx.commerce.newId();
        const record = { ...newPackageRecord(input), id, familyId: id };
        const created = await tx.commerce.createPackage(record);
        if (input.prices?.length) await tx.commerce.setPackagePrices(created.id, normalizePrices(input.prices));
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
        if (before.supersededBy) throw new AppError('CONFLICT', 409, 'A newer version of this plan exists: change that one.');
        await this.checkChannels(input.channelIds);
        await this.checkTerms({ ...before, ...termsPatch(input) }, input.prices);
        if (input.slug && slugify(input.slug) !== before.slug && (await commerce.findPackage(slugify(input.slug)))) throw new AppError('CONFLICT', 409, 'A package with this slug already exists.');
        const [channels, prices, holders] = await Promise.all([commerce.packageChannels(before.id), commerce.packagePrices([before.id]), commerce.packageHolders([before.id], this.deps.clock.now())]);
        const currentPrices = prices.get(before.id) ?? [];
        // Name the channels that move, so the approver sees what the change does, not just counts.
        const touched = input.channelIds ? [...new Set([...input.channelIds, ...channels])].filter((id) => !input.channelIds!.includes(id) || !channels.includes(id)) : [];
        const names = new Map((touched.length ? await this.deps.catalog.findChannels(touched) : []).map((channel) => [channel.id, channel.name]));
        const versioned = versionedChange(before, currentPrices, input, holders.get(before.id) ?? 0);
        return { payload: { ...input }, summary: describeUpdate(before, channels, currentPrices, input, names, versioned), base: packageState(before, channels, currentPrices) };
      },
      current: async (tx, targetId) => {
        const pkg = await tx.commerce.findPackage(targetId);
        return pkg ? packageState(pkg, await tx.commerce.packageChannels(pkg.id), (await tx.commerce.packagePrices([pkg.id])).get(pkg.id) ?? []) : null;
      },
      apply: async (tx, actor, change, context) => {
        const input = change.payload as unknown as UpdatePackageRequest;
        const before = change.targetId ? await tx.commerce.findPackage(change.targetId) : null;
        if (!before) throw AppError.notFound('Package');
        if (before.supersededBy) throw new AppError('CONFLICT', 409, 'A newer version of this plan exists: change that one.');
        await this.checkChannels(input.channelIds, tx);
        const beforeChannels = await tx.commerce.packageChannels(before.id);
        const beforePrices = (await tx.commerce.packagePrices([before.id])).get(before.id) ?? [];
        const holders = (await tx.commerce.packageHolders([before.id], this.deps.clock.now())).get(before.id) ?? 0;
        const { channelIds, prices, ...rest } = input;
        const patch = { ...rest, ...termsPatch(input), ...(rest.slug ? { slug: slugify(rest.slug) } : {}), ...(rest.currency ? { currency: rest.currency.toUpperCase() } : {}) };
        const nextPrices = prices ? normalizePrices(prices) : beforePrices;
        let target: PackageRecord;
        const versioned = versionedChange(before, beforePrices, input, holders);
        if (versioned) {
          // Grandfathering: holders keep this version (its terms, its price); the plan goes on as a new one.
          const family = await tx.commerce.packageFamily(before.familyId);
          const version = Math.max(...family.map((item) => item.version)) + 1;
          const slug = patch.slug ?? before.slug;
          await tx.commerce.updatePackage(before.id, { slug: `${before.slug}-v${before.version}`, status: 'retired' });
          const { createdAt: _createdAt, ...base } = before;
          target = await tx.commerce.createPackage({ ...base, ...patch, slug, id: tx.commerce.newId(), version, supersededBy: null, status: patch.status ?? before.status });
          await tx.commerce.updatePackage(before.id, { supersededBy: target.id });
          await tx.commerce.setPackageChannels(target.id, beforeChannels);
          await tx.commerce.setPackagePrices(target.id, nextPrices);
        } else {
          target = (await tx.commerce.updatePackage(before.id, patch)) ?? before;
          if (prices) await tx.commerce.setPackagePrices(before.id, nextPrices);
        }
        // Channels follow the licence: every version of the plan carries the same ones.
        if (channelIds) for (const member of await tx.commerce.packageFamily(before.familyId)) await tx.commerce.setPackageChannels(member.id, channelIds);
        await this.audit(tx, actor, context, versioned ? 'package.versioned' : 'package.updated', target.id, packageState(before, beforeChannels, beforePrices), packageState(target, channelIds ?? beforeChannels, nextPrices), {
          changes: Object.keys(input),
          ...(versioned ? { previousVersion: before.id, version: target.version, holdersKept: holders, terms: versioned } : {}),
          changeRequest: change.requestId,
          requestedBy: change.requestedBy,
        });
        const removed = channelIds ? beforeChannels.filter((channelId) => !channelIds.includes(channelId)) : [];
        const result: PackageUpdateResult = { packageId: target.id, removed };
        return { targetId: before.id, result };
      },
      afterCommit: async (_change, result) => {
        this.deps.onCatalogChange?.();
        // Viewings a removed channel's package allowed stop now, not at their next heartbeat.
        for (const channelId of (result as PackageUpdateResult).removed) await this.deps.authorization.revalidateChannel(channelId);
      },
    };
    const promo: ChangeHandler = {
      kind: 'promo.create',
      targetType: 'promo',
      prepare: async (payload) => {
        const input = payload as unknown as CreatePromoRequest;
        const record = await this.newPromo(input);
        if (await commerce.findPromo(record.code)) throw new AppError('CONFLICT', 409, 'A promo code with this code already exists.');
        return { payload: { ...input, code: record.code }, summary: describePromo(record), base: null };
      },
      apply: async (tx, actor, change, context) => {
        const input = change.payload as unknown as CreatePromoRequest;
        const record = { ...(await this.newPromo(input)), id: tx.commerce.newId(), createdBy: change.requestedBy };
        const created = await tx.commerce.createPromo(record);
        await this.audit(tx, actor, context, 'promo.created', created.id, null, created, { code: created.code, changeRequest: change.requestId, requestedBy: change.requestedBy });
        return { targetId: created.id, result: created.id };
      },
    };
    return [create, update, promo];
  }

  // --- promo codes -------------------------------------------------------------------------------

  async promos(): Promise<PromoCodeDto[]> {
    return (await this.deps.commerce.listPromos()).map(toPromoDto);
  }

  /** New promo code: through four-eyes approval (a discount is money) unless it is off. */
  async createPromo(actor: StaffPrincipal, input: CreatePromoRequest, context: AdminContext): Promise<{ status: 'applied'; promo: PromoCodeDto } | { status: 'pending'; request: ChangeRequestDto }> {
    const outcome = await this.deps.changes.propose(actor, 'promo.create', null, { ...input }, context);
    if (outcome.status === 'pending') return { status: 'pending', request: outcome.request };
    const created = await this.deps.commerce.findPromo(String(outcome.result));
    if (!created) throw AppError.notFound('Promo code');
    return { status: 'applied', promo: toPromoDto(created) };
  }

  /** Stopping a code (or annotating it) acts at once: it only narrows what is given away. */
  async updatePromo(actor: StaffPrincipal, id: string, input: UpdatePromoRequest, context: AdminContext): Promise<PromoCodeDto> {
    const before = await this.deps.commerce.findPromo(id);
    if (!before || before.id !== id) throw AppError.notFound('Promo code');
    const after = await this.write(async (tx) => {
      const updated = await tx.commerce.updatePromo(id, { ...(input.active === false ? { active: false } : {}), ...(input.note !== undefined ? { note: input.note.trim() } : {}) });
      if (!updated) throw AppError.notFound('Promo code');
      await this.audit(tx, actor, context, input.active === false ? 'promo.deactivated' : 'promo.updated', id, before, updated, { code: before.code });
      return updated;
    });
    return toPromoDto(after);
  }

  private async newPromo(input: CreatePromoRequest): Promise<Omit<PromoCodeRecord, 'id' | 'redemptions' | 'createdAt' | 'createdBy'> & { createdBy: string | null }> {
    const code = normalizePromoCode(input.code);
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw AppError.validation('A promo code is 3–32 letters, digits, dashes or underscores.');
    if (input.kind === 'percent' && (input.value < 1 || input.value > 100)) throw AppError.validation('A percentage is between 1 and 100.');
    if (input.kind === 'amount' && !input.currency) throw AppError.validation('A fixed discount needs a currency.');
    const startsAt = input.startsAt ? new Date(input.startsAt) : this.deps.clock.now();
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    if (endsAt && endsAt <= startsAt) throw AppError.validation('A promo code must end after it starts.');
    const families = [...new Set(input.families ?? [])];
    if (families.length) {
      const found = await this.deps.commerce.findPackages(families);
      if (found.filter((pkg) => pkg.familyId === pkg.id).length !== families.length) throw AppError.validation('The promo code names a plan that does not exist.');
    }
    return {
      code,
      kind: input.kind,
      value: input.value,
      currency: input.kind === 'amount' ? input.currency!.toUpperCase() : null,
      families,
      maxRedemptions: input.maxRedemptions ?? null,
      startsAt,
      endsAt,
      active: true,
      note: input.note?.trim() ?? '',
      createdBy: null,
    };
  }

  /** VOD mode needs vendor packages exactly when it is `package`; those packages and the prices must be real. */
  private async checkTerms(terms: Pick<PackageRecord, 'vodMode' | 'vodPackages'>, prices: readonly RegionalPriceDto[] | undefined): Promise<void> {
    if (terms.vodMode === 'package' && terms.vodPackages.length === 0) throw AppError.validation('A plan that sells VOD by package must open at least one vendor package.');
    if (terms.vodMode !== 'package' && terms.vodPackages.length > 0) throw AppError.validation('Vendor packages only apply to plans that sell VOD by package.');
    if (terms.vodPackages.length) {
      const known = new Set((await this.deps.feeds.packageOptions()).map((option) => option.id));
      if (terms.vodPackages.some((id) => !known.has(id))) throw AppError.validation('The plan names a vendor package that does not exist.');
    }
    if (prices) {
      const countries = prices.map((price) => price.country.toUpperCase());
      if (countries.some((country) => !isCountryCode(country))) throw AppError.validation('Regional prices need ISO country codes (GE, DE…).');
      if (new Set(countries).size !== countries.length) throw AppError.validation('One price per country.');
    }
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

interface PackageUpdateResult {
  /** The version the change ended on (a new one when the plan was versioned). */
  packageId: string;
  /** Channels taken out (their viewings are revalidated now). */
  removed: string[];
}

function newPackageRecord(input: CreatePackageRequest): Omit<PackageRecord, 'createdAt' | 'id' | 'familyId'> {
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
    vodMode: input.vodMode ?? 'none',
    vodPackages: [...new Set(input.vodPackages ?? [])],
    maxQuality: input.maxQuality ?? null,
    catchupDays: input.catchupDays ?? null,
    version: 1,
    supersededBy: null,
  };
}

/** The entitlement fields of a change, normalised (vendor packages deduplicated). */
function termsPatch(input: UpdatePackageRequest): Partial<Pick<PackageRecord, 'vodMode' | 'vodPackages' | 'maxQuality' | 'catchupDays'>> {
  return {
    ...(input.vodMode !== undefined ? { vodMode: input.vodMode } : {}),
    ...(input.vodPackages !== undefined ? { vodPackages: [...new Set(input.vodPackages)] } : {}),
    ...(input.vodMode !== undefined && input.vodMode !== 'package' && input.vodPackages === undefined ? { vodPackages: [] } : {}),
    ...(input.maxQuality !== undefined ? { maxQuality: input.maxQuality } : {}),
    ...(input.catchupDays !== undefined ? { catchupDays: input.catchupDays } : {}),
  };
}

function normalizePrices(prices: readonly RegionalPriceDto[]): RegionalPrice[] {
  return prices.map((price) => ({ country: price.country.toUpperCase(), currency: price.currency.toUpperCase(), priceMinor: price.priceMinor })).sort((a, b) => a.country.localeCompare(b.country));
}

/** The versioned terms a change touches when the plan is held and on sale (null = changes in place). */
function versionedChange(before: PackageRecord, prices: readonly RegionalPrice[], input: UpdatePackageRequest, holders: number): VersionedTerm[] | null {
  if (holders === 0 || before.status === 'draft') return null;
  const current: Record<VersionedTerm, unknown> = { ...before, prices };
  const patch: Partial<Record<VersionedTerm, unknown>> = { ...input, ...termsPatch(input), ...(input.currency ? { currency: input.currency.toUpperCase() } : {}), ...(input.prices ? { prices: normalizePrices(input.prices) } : {}) };
  const terms = changedTerms(current, patch);
  return terms.length > 0 ? terms : null;
}

/** What four-eyes compares: the package's sellable terms, its channels and prices (order-free). */
function packageState(pkg: PackageRecord, channels: readonly string[], prices: readonly RegionalPrice[]) {
  const { createdAt: _createdAt, ...terms } = pkg;
  return { ...terms, vodPackages: [...pkg.vodPackages].sort(), channels: [...channels].sort(), prices: [...prices].sort((a, b) => a.country.localeCompare(b.country)) };
}

const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;
const quality = (value: PackageRecord['maxQuality']) => (value ? value.toUpperCase() : 'licence');
const catchup = (value: number | null) => (value === null ? 'licence' : `${value} d`);
const priceList = (prices: readonly { country: string; priceMinor: number; currency: string }[]) => (prices.length ? prices.map((price) => `${price.country.toUpperCase()} ${money(price.priceMinor, price.currency.toUpperCase())}`).join(', ') : 'none');

function describeCreate(record: Omit<PackageRecord, 'createdAt' | 'id' | 'familyId'>, prices: readonly RegionalPriceDto[]): string {
  return [
    `New package “${record.name}” (${record.slug}, ${record.businessModel}) — ${money(record.priceMinor, record.currency)}/${record.billingPeriod}`,
    `${record.maxStreams} stream(s), ${record.maxDevices} device(s)`,
    `VOD ${record.vodMode}${record.vodMode === 'package' ? ` (${record.vodPackages.length} vendor package(s))` : ''}`,
    `quality ${quality(record.maxQuality)}, catch-up ${catchup(record.catchupDays)}`,
    ...(record.trialDays ? [`${record.trialDays}-day trial`] : []),
    ...(prices.length ? [`regional prices ${priceList(prices)}`] : []),
  ].join(', ');
}

function describePromo(record: Pick<PromoCodeRecord, 'code' | 'kind' | 'value' | 'currency' | 'families' | 'maxRedemptions' | 'startsAt' | 'endsAt'>): string {
  const discount = record.kind === 'percent' ? `${record.value} % off` : `${money(record.value, record.currency ?? '')} off`;
  return `Promo code ${record.code}: ${discount} the first payment, ${record.families.length ? `${record.families.length} plan(s)` : 'every plan'}, ${record.maxRedemptions ? `up to ${record.maxRedemptions} uses` : 'unlimited uses'}, ${record.startsAt.toISOString().slice(0, 10)} – ${record.endsAt ? record.endsAt.toISOString().slice(0, 10) : 'open-ended'}`;
}

/** "Basic: price 9.99 GEL → 12.99 GEL; status draft → active; channels 3 → 5 (+2)". */
function describeUpdate(before: PackageRecord, channels: readonly string[], prices: readonly RegionalPrice[], input: UpdatePackageRequest, names: ReadonlyMap<string, string>, versioned: VersionedTerm[] | null): string {
  const parts: string[] = [];
  const currency = input.currency?.toUpperCase() ?? before.currency;
  if ((input.priceMinor !== undefined && input.priceMinor !== before.priceMinor) || currency !== before.currency) parts.push(`price ${money(before.priceMinor, before.currency)} → ${money(input.priceMinor ?? before.priceMinor, currency)}`);
  if (input.status && input.status !== before.status) parts.push(`status ${before.status} → ${input.status}`);
  if (input.billingPeriod && input.billingPeriod !== before.billingPeriod) parts.push(`period ${before.billingPeriod} → ${input.billingPeriod}`);
  if (input.trialDays !== undefined && input.trialDays !== before.trialDays) parts.push(`trial ${before.trialDays} → ${input.trialDays} days`);
  if (input.maxStreams !== undefined && input.maxStreams !== before.maxStreams) parts.push(`streams ${before.maxStreams} → ${input.maxStreams}`);
  if (input.maxDevices !== undefined && input.maxDevices !== before.maxDevices) parts.push(`devices ${before.maxDevices} → ${input.maxDevices}`);
  const terms = termsPatch(input);
  if (terms.vodMode !== undefined && terms.vodMode !== before.vodMode) parts.push(`VOD ${before.vodMode} → ${terms.vodMode}`);
  if (terms.vodPackages !== undefined && JSON.stringify([...terms.vodPackages].sort()) !== JSON.stringify([...before.vodPackages].sort())) parts.push(`vendor packages ${before.vodPackages.length} → ${terms.vodPackages.length}`);
  if (terms.maxQuality !== undefined && terms.maxQuality !== before.maxQuality) parts.push(`quality ${quality(before.maxQuality)} → ${quality(terms.maxQuality)}`);
  if (terms.catchupDays !== undefined && terms.catchupDays !== before.catchupDays) parts.push(`catch-up ${catchup(before.catchupDays)} → ${catchup(terms.catchupDays)}`);
  if (input.prices && JSON.stringify(normalizePrices(input.prices)) !== JSON.stringify(prices)) parts.push(`regional prices ${priceList(prices)} → ${priceList(input.prices)}`);
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
  if (versioned) parts.push(`creates version ${before.version + 1} — current holders keep version ${before.version}`);
  return `${before.name}: ${parts.length ? parts.join('; ') : 'no effective change'}`;
}

function toPackageDto(pkg: PackageRecord, channels: number, prices: readonly RegionalPrice[], holders: number): PackageDto {
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
    vodMode: pkg.vodMode,
    vodPackages: pkg.vodPackages,
    maxQuality: pkg.maxQuality,
    catchupDays: pkg.catchupDays,
    prices: prices.map((price) => ({ ...price })),
    familyId: pkg.familyId,
    version: pkg.version,
    supersededBy: pkg.supersededBy,
    holders,
  };
}

function toPromoDto(promo: PromoCodeRecord): PromoCodeDto {
  return {
    id: promo.id,
    code: promo.code,
    kind: promo.kind,
    value: promo.value,
    currency: promo.currency,
    families: [...promo.families],
    maxRedemptions: promo.maxRedemptions,
    redemptions: promo.redemptions,
    startsAt: promo.startsAt.toISOString(),
    endsAt: promo.endsAt?.toISOString() ?? null,
    active: promo.active,
    note: promo.note,
    createdAt: promo.createdAt.toISOString(),
  };
}

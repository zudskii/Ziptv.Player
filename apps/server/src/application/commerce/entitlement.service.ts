import { decideAccess, isEntitlementActive, limitsOf, type AccessDecision, type PackageView } from '../../domain/commerce/entitlement.js';
import { decideVod, licensedRight, opensVod, planCatchupDays, type PlanTerms, type VodDecision, type VodItemView } from '../../domain/commerce/plan.js';
import { findCoveringGrant, type RightsGrant } from '../../domain/operator/rights.js';
import type { Quality } from '../../domain/operator/vendor-feed.js';
import type { Viewer } from '../identity/viewer.js';
import type { Clock } from '../ports/clock.js';
import type { CommerceRepository, EntitlementRecord, PackageRecord } from '../ports/commerce.js';
import type { ViewingContext } from '../operator/operator.service.js';

export type OperatorAccessMode = 'subscription' | 'rights';

export interface ViewerAccess {
  blocked: boolean;
  entitlements: EntitlementRecord[];
  /** Packages the viewer holds now. */
  packages: PackageRecord[];
  limits: { maxStreams: number; maxDevices: number };
}

/** What a plan adds to a viewing it allows: ceilings on top of the licence (null = the licence decides). */
export interface PlanLimits {
  maxQuality: Quality | null;
  catchupDays: number | null;
}

export interface VodVerdict {
  decision: VodDecision;
  /** Plans on sale that would open the item (offered as an upgrade). */
  upgrade: { slug: string; name: string }[];
}

const NO_PLAN_LIMITS: PlanLimits = { maxQuality: null, catchupDays: null };

const toView = (pkg: PackageRecord): PackageView => ({ id: pkg.id, businessModel: pkg.businessModel, maxStreams: pkg.maxStreams, maxDevices: pkg.maxDevices, maxQuality: pkg.maxQuality, catchupDays: pkg.catchupDays });

export const toPlanTerms = (pkg: PackageRecord): PlanTerms => ({
  id: pkg.id,
  businessModel: pkg.businessModel,
  vodMode: pkg.vodMode,
  vodPackages: pkg.vodPackages,
  maxQuality: pkg.maxQuality,
  catchupDays: pkg.catchupDays,
  maxStreams: pkg.maxStreams,
  maxDevices: pkg.maxDevices,
});

/**
 * Application side of the entitlement engine (one engine for playback, catalogue and UI): loads
 * what the domain rules need (account state, entitlements, the channel's packages, the plans on
 * sale) and asks them. Used for the channel list (locked / which plan unlocks it / archive days),
 * the VOD catalogue (included / upgrade), authorizing a viewing and every heartbeat of it.
 */
export class EntitlementService {
  constructor(
    private readonly deps: {
      commerce: CommerceRepository;
      clock: Clock;
      mode: OperatorAccessMode;
      /** Limits without a package (FAST viewers, rights-only deployments). */
      defaults: { maxStreams: number; maxDevices: number };
    },
  ) {}

  get mode(): OperatorAccessMode {
    return this.deps.mode;
  }

  async viewerAccess(viewer: Pick<Viewer, 'userId'>): Promise<ViewerAccess> {
    const [account, entitlements] = await Promise.all([this.deps.commerce.account(viewer.userId), this.deps.commerce.entitlementsOf(viewer.userId)]);
    const now = this.deps.clock.now();
    const packages = await this.deps.commerce.findPackages([...new Set(entitlements.filter((entitlement) => isEntitlementActive(toEntitlement(entitlement), now)).map((entitlement) => entitlement.packageId))]);
    return { blocked: Boolean(account?.blockedAt), entitlements, packages, limits: limitsOf(packages.map(toView), entitlements.map(toEntitlement), now, this.deps.defaults) };
  }

  async decide(access: ViewerAccess, channelId: string, grants: readonly RightsGrant[], context: ViewingContext): Promise<AccessDecision> {
    const channelPackages = (await this.deps.commerce.packagesOfChannels([channelId])).get(channelId) ?? [];
    return decideAccess({
      now: this.deps.clock.now(),
      mode: this.deps.mode,
      blocked: access.blocked,
      country: context.country,
      device: context.device,
      grants,
      entitlements: access.entitlements.map(toEntitlement),
      channelPackages: channelPackages.map(toView),
    });
  }

  /** The plan's ceilings for a viewing it allows (FAST / rights-only viewings: none). */
  planLimits(access: ViewerAccess, decision: AccessDecision): PlanLimits {
    if (!decision.allowed || decision.via.kind !== 'package') return NO_PLAN_LIMITS;
    const { packageId } = decision.via;
    const pkg = access.packages.find((item) => item.id === packageId);
    return pkg ? { maxQuality: pkg.maxQuality, catchupDays: pkg.catchupDays } : NO_PLAN_LIMITS;
  }

  /**
   * Channel list annotations: `locked` = rights allow it here but the viewer has no plan for it
   * (the UI offers the plans that unlock it); `catchupDays` = the licensed archive narrowed by the
   * plan that allows the viewing. Channels without rights are not listed at all.
   */
  async annotate(viewer: Viewer, channels: { id: string; grants: readonly RightsGrant[]; catchupDays: number }[], context: ViewingContext): Promise<Map<string, { locked: boolean; packages: { slug: string; name: string }[]; catchupDays: number }>> {
    const result = new Map<string, { locked: boolean; packages: { slug: string; name: string }[]; catchupDays: number }>();
    if (this.deps.mode === 'rights' || channels.length === 0) return result;
    const [access, packagesByChannel] = await Promise.all([this.viewerAccess(viewer), this.deps.commerce.packagesOfChannels(channels.map((channel) => channel.id))]);
    const now = this.deps.clock.now();
    for (const channel of channels) {
      const packages = packagesByChannel.get(channel.id) ?? [];
      const decision = decideAccess({
        now,
        mode: 'subscription',
        blocked: access.blocked,
        country: context.country,
        device: context.device,
        grants: channel.grants,
        entitlements: access.entitlements.map(toEntitlement),
        channelPackages: packages.map(toView),
      });
      const where = { country: context.country, device: context.device, at: now };
      result.set(channel.id, {
        locked: !decision.allowed,
        // Only plans on sale can be offered.
        packages: decision.allowed ? [] : packages.filter((pkg) => pkg.status === 'active' && findCoveringGrant(channel.grants, { ...where, model: pkg.businessModel })).map((pkg) => ({ slug: pkg.slug, name: pkg.name })),
        catchupDays: planCatchupDays(channel.catchupDays, this.planLimits(access, decision).catchupDays),
      });
    }
    return result;
  }

  /**
   * VOD (films, series) for one viewer: the decision per item and, when it is not in their plan,
   * the plans on sale that would open it. In rights-only deployments every licensed item is open.
   */
  async vod(viewer: Viewer, items: readonly (VodItemView & { id: string })[], context: ViewingContext): Promise<Map<string, VodVerdict>> {
    const result = new Map<string, VodVerdict>();
    if (items.length === 0) return result;
    const now = this.deps.clock.now();
    if (this.deps.mode === 'rights') {
      for (const item of items) {
        const right = licensedRight(item.rights, { ...context, at: now, model: 'subscription' }) ?? licensedRight(item.rights, { ...context, at: now, model: 'b2b' });
        result.set(item.id, { decision: right ? { allowed: true, planId: '', maxQuality: right.maxQuality } : { allowed: false, reason: 'not_licensed', maxQuality: null }, upgrade: [] });
      }
      return result;
    }
    const [access, onSale] = await Promise.all([this.viewerAccess(viewer), this.deps.commerce.vodPlans()]);
    const held = access.packages.map(toPlanTerms);
    const offers = onSale.filter((pkg) => pkg.status === 'active');
    for (const item of items) {
      const decision = decideVod({ now, blocked: access.blocked, country: context.country, device: context.device, item, plans: held });
      const upgrade =
        decision.allowed || decision.reason === 'not_licensed' || decision.reason === 'account_blocked'
          ? []
          : offers.filter((pkg) => opensVod(pkg, item) && licensedRight(item.rights, { ...context, at: now, model: pkg.businessModel })).map((pkg) => ({ slug: pkg.slug, name: pkg.name }));
      result.set(item.id, { decision, upgrade });
    }
    return result;
  }
}

function toEntitlement(entitlement: EntitlementRecord) {
  return { packageId: entitlement.packageId, startsAt: entitlement.startsAt, endsAt: entitlement.endsAt, revoked: entitlement.revokedAt !== null };
}

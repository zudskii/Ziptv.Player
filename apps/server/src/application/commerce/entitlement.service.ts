import { decideAccess, isEntitlementActive, limitsOf, type AccessDecision, type PackageView } from '../../domain/commerce/entitlement.js';
import { findCoveringGrant, type RightsGrant } from '../../domain/operator/rights.js';
import type { Viewer } from '../identity/viewer.js';
import type { Clock } from '../ports/clock.js';
import type { CommerceRepository, EntitlementRecord, PackageRecord } from '../ports/commerce.js';
import type { ViewingContext } from '../operator/operator.service.js';

export type OperatorAccessMode = 'subscription' | 'rights';

export interface ViewerAccess {
  blocked: boolean;
  entitlements: EntitlementRecord[];
  packages: PackageRecord[];
  limits: { maxStreams: number; maxDevices: number };
}

const toView = (pkg: PackageRecord): PackageView => ({ id: pkg.id, businessModel: pkg.businessModel, maxStreams: pkg.maxStreams, maxDevices: pkg.maxDevices });

/**
 * Application side of the entitlement engine: loads what the domain rule needs (account state,
 * entitlements, the channel's packages) and asks it. Used for the channel list (locked / which
 * package unlocks it), for authorizing a viewing and for every heartbeat of it.
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

  /**
   * Channel list annotations: `locked` = rights allow it here but the viewer has no package for it
   * (the UI offers the packages that unlock it). Channels without rights are not listed at all.
   */
  async annotate(viewer: Viewer, channels: { id: string; grants: readonly RightsGrant[] }[], context: ViewingContext): Promise<Map<string, { locked: boolean; packages: { slug: string; name: string }[] }>> {
    const result = new Map<string, { locked: boolean; packages: { slug: string; name: string }[] }>();
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
        // Only packages on sale can be offered.
        packages: decision.allowed ? [] : packages.filter((pkg) => pkg.status === 'active' && findCoveringGrant(channel.grants, { ...where, model: pkg.businessModel })).map((pkg) => ({ slug: pkg.slug, name: pkg.name })),
      });
    }
    return result;
  }
}

function toEntitlement(entitlement: EntitlementRecord) {
  return { packageId: entitlement.packageId, startsAt: entitlement.startsAt, endsAt: entitlement.endsAt, revoked: entitlement.revokedAt !== null };
}

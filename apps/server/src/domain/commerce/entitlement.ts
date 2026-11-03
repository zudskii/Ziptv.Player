import type { BusinessModel, DeviceClass } from '../operator/catalog.js';
import { findCoveringGrant, denialReason, type RightsGrant } from '../operator/rights.js';

/**
 * Entitlement engine (ZP-ENT-08): may this viewer play this channel here, now?
 *
 *   account not blocked
 *   ∧ rights: an active grant covers the viewer's country, device class and time
 *   ∧ one of:
 *       a grant for the FAST model (free, ad-supported)            → open to everyone
 *       an active entitlement to a package that contains the channel,
 *       with a grant for that package's business model             → subscribed
 *       (OPERATOR_ACCESS=rights: rights alone suffice — no commerce)
 */

export interface EntitlementView {
  packageId: string;
  /** null = open-ended (comp / B2B). */
  endsAt: Date | null;
  startsAt: Date;
  revoked: boolean;
}

export interface PackageView {
  id: string;
  businessModel: BusinessModel;
  maxStreams: number;
  maxDevices: number;
}

export type AccessDenial = 'account_blocked' | 'territory' | 'device' | 'not_licensed' | 'no_subscription' | 'not_in_package';

export type AccessDecision =
  | { allowed: true; via: { kind: 'package'; packageId: string } | { kind: 'fast' } | { kind: 'rights' } }
  | { allowed: false; reason: AccessDenial };

export interface AccessInput {
  now: Date;
  mode: 'subscription' | 'rights';
  blocked: boolean;
  country: string | null;
  device: DeviceClass;
  grants: readonly RightsGrant[];
  /** The viewer's entitlements (any state; filtered here). */
  entitlements: readonly EntitlementView[];
  /** Packages that contain the channel. */
  channelPackages: readonly PackageView[];
}

export function isEntitlementActive(entitlement: EntitlementView, now: Date): boolean {
  return !entitlement.revoked && entitlement.startsAt <= now && (entitlement.endsAt === null || entitlement.endsAt > now);
}

export function decideAccess(input: AccessInput): AccessDecision {
  if (input.blocked) return { allowed: false, reason: 'account_blocked' };
  const where = { country: input.country, device: input.device, at: input.now };
  if (!findCoveringGrant(input.grants, where)) return { allowed: false, reason: denialReason(input.grants, where) };
  if (input.mode === 'rights') return { allowed: true, via: { kind: 'rights' } };

  if (findCoveringGrant(input.grants, { ...where, model: 'fast' })) return { allowed: true, via: { kind: 'fast' } };

  const active = new Set(input.entitlements.filter((entitlement) => isEntitlementActive(entitlement, input.now)).map((entitlement) => entitlement.packageId));
  for (const pkg of input.channelPackages) {
    // The package must carry the channel *and* the licence must allow selling it that way.
    if (active.has(pkg.id) && findCoveringGrant(input.grants, { ...where, model: pkg.businessModel })) return { allowed: true, via: { kind: 'package', packageId: pkg.id } };
  }
  return { allowed: false, reason: active.size > 0 ? 'not_in_package' : 'no_subscription' };
}

/** Limits of a viewer: the most generous active package (defaults without one). */
export function limitsOf(packages: readonly PackageView[], entitlements: readonly EntitlementView[], now: Date, defaults: { maxStreams: number; maxDevices: number }): { maxStreams: number; maxDevices: number } {
  const active = new Set(entitlements.filter((entitlement) => isEntitlementActive(entitlement, now)).map((entitlement) => entitlement.packageId));
  const owned = packages.filter((pkg) => active.has(pkg.id));
  if (owned.length === 0) return defaults;
  return { maxStreams: Math.max(...owned.map((pkg) => pkg.maxStreams)), maxDevices: Math.max(...owned.map((pkg) => pkg.maxDevices)) };
}

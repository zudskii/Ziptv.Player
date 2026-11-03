import type { BusinessModel, DeviceClass } from './catalog.js';

/**
 * Rights: the business invariant of the operator catalog. A master channel may be listed and
 * played for a viewer only while an active grant covers the viewer's territory, device class
 * and (when known) business model at that moment. No grant → not visible, not playable.
 */
export interface RightsGrant {
  id: string;
  channelId: string;
  /** ISO country or '*' (worldwide). */
  territory: string;
  deviceClasses: readonly DeviceClass[];
  businessModels: readonly BusinessModel[];
  startAt: Date;
  endAt: Date | null;
  status: 'active' | 'revoked';
}

export interface RightsQuery {
  /** Where the viewer is (server-determined); null = unknown → only worldwide grants apply. */
  country: string | null;
  device: DeviceClass;
  at: Date;
  /** Commerce (packages/entitlements) narrows this later; undefined = any licensed model. */
  model?: BusinessModel;
}

export function grantCovers(grant: RightsGrant, query: RightsQuery): boolean {
  if (grant.status !== 'active') return false;
  if (grant.startAt.getTime() > query.at.getTime()) return false;
  if (grant.endAt && grant.endAt.getTime() <= query.at.getTime()) return false;
  if (grant.territory !== '*' && grant.territory !== query.country) return false;
  if (!grant.deviceClasses.includes(query.device)) return false;
  if (query.model && !grant.businessModels.includes(query.model)) return false;
  return true;
}

/** The grant that allows this viewing, or null. */
export function findCoveringGrant(grants: readonly RightsGrant[], query: RightsQuery): RightsGrant | null {
  return grants.find((grant) => grantCovers(grant, query)) ?? null;
}

/** In force at `at` somewhere (any territory/device): the channel is carried at all. */
export function isLicensedAt(grants: readonly RightsGrant[], at: Date): boolean {
  return grants.some((grant) => grant.status === 'active' && grant.startAt <= at && (!grant.endAt || grant.endAt > at));
}

/**
 * Why a channel is not playable (for the error screen): "not in your country" when a grant
 * exists for another territory/time, otherwise "not licensed".
 */
export function denialReason(grants: readonly RightsGrant[], query: RightsQuery): 'territory' | 'device' | 'not_licensed' {
  const live = grants.filter((grant) => isLicensedAt([grant], query.at));
  if (live.some((grant) => grant.territory === '*' || grant.territory === query.country)) return 'device';
  return live.length > 0 ? 'territory' : 'not_licensed';
}

import type { BusinessModel, DeviceClass } from './catalog.js';
import { QUALITIES, type Quality } from './vendor-feed.js';

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
  /** Catch-up is licensed separately: how many days back viewers may replay (0 = live only). */
  catchupDays: number;
  /** Highest picture quality licensed under this grant; null = no limit. */
  maxQuality: Quality | null;
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
 * Grants under which this viewer may replay a programme aired at `airedAt`: catch-up rights that
 * cover the viewer here and now, that already covered the broadcast (the licence was in force
 * when it aired — an archive never reaches back before the licence began) and whose catch-up
 * window reaches back that far.
 */
export function catchupGrants<T extends RightsGrant>(grants: readonly T[], query: RightsQuery, airedAt: Date): T[] {
  return grants.filter(
    (grant) =>
      grant.catchupDays > 0 &&
      grantCovers(grant, query) &&
      grantCovers(grant, { ...query, at: airedAt }) &&
      airedAt.getTime() >= query.at.getTime() - grant.catchupDays * 86_400_000,
  );
}

/** The longest catch-up window (days) the viewer has on a channel right now (0 = none). */
export function catchupDaysFor(grants: readonly RightsGrant[], query: RightsQuery): number {
  return grants.reduce((days, grant) => (grant.catchupDays > days && grantCovers(grant, query) ? grant.catchupDays : days), 0);
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

/**
 * The quality cap for this viewing: the most generous of the grants that cover it (a viewer covered
 * by an unlimited grant has no cap). Null = no cap; undefined grants list = nothing covers.
 */
export function qualityCapFor(grants: readonly RightsGrant[], query: RightsQuery): Quality | null {
  let best: Quality | null | undefined;
  for (const grant of grants) {
    if (!grantCovers(grant, query)) continue;
    if (grant.maxQuality === null) return null;
    if (best === undefined || best === null || QUALITIES.indexOf(grant.maxQuality) > QUALITIES.indexOf(best)) best = grant.maxQuality;
  }
  return best ?? null;
}

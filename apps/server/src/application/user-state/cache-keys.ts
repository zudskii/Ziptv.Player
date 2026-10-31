import type { Cache } from '../ports/cache.js';

const EPOCH_TTL_MS = 24 * 3600_000;

/** Cache key prefix of everything personal to one profile (Home rails). */
export const homeCachePrefix = (profileId: string): string => `home:${profileId}:`;

const epochKey = (profileId: string) => `home-epoch:${profileId}`;

/**
 * Part of every Home cache key. Invalidation moves it forward, so a Home build that was already
 * running when the state changed stores its (stale) result under a key nobody reads any more.
 */
export function homeEpoch(cache: Cache, profileId: string): number {
  return cache.get<number>(epochKey(profileId)) ?? 0;
}

export function invalidateHome(cache: Cache, profileId: string): void {
  cache.set(epochKey(profileId), homeEpoch(cache, profileId) + 1, EPOCH_TTL_MS);
  cache.deleteByPrefix(homeCachePrefix(profileId));
}

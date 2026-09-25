import { groupIdentity } from './text.js';

/**
 * Stable identity for a channel inside a playlist.
 *
 * Derived from name + groups rather than from the URL: provider URLs rotate tokens on every
 * refresh, while favourites/recents/deep links must survive a refresh. (tvg-id is not used
 * because SD/HD/FHD variants of one channel usually share it.) Exact duplicates get a
 * numeric suffix so keys stay unique; keys are URL-safe (`^[a-f0-9]{12}(-\d+)?$`).
 */
export function createChannelKeyFactory(): (input: { name: string; groups: string[] }) => string {
  const seen = new Map<string, number>();
  return ({ name, groups }) => {
    const identity = `${name.toLowerCase()}\u0000${groups.map(groupIdentity).join(';')}`;
    const base = hash53(identity).toString(16).padStart(14, '0').slice(-12);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return occurrence === 1 ? base : `${base}-${occurrence}`;
  };
}

/**
 * cyrb53: fast, well-distributed 53-bit string hash. Not cryptographic — it only needs to be
 * stable and collision-resistant enough for ids within one playlist (a collision would merely
 * produce a `-2` suffix, never a wrong channel). ~10x faster than sha1 on 100k channels.
 */
function hash53(value: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

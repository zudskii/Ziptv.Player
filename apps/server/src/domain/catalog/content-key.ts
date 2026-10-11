/**
 * Stable identities for catalog items (live channels, movies, series, episodes).
 *
 * Derived from name + groups rather than from the URL: provider URLs rotate tokens on every
 * sync, while My List / history / progress / deep links must survive a sync. (tvg-id is not
 * used because SD/HD/FHD variants of one channel usually share it.) Exact duplicates get a
 * numeric suffix so keys stay unique; keys are URL-safe (`^[a-f0-9]{12}(-\d+)?$`).
 *
 * The algorithm is unchanged since 2.x, so 2.x channel keys (favourites in old browsers,
 * migrated playlists) still resolve to the same channels.
 */
export const CONTENT_KEY_PATTERN = /^[a-f0-9]{12}(-\d{1,6})?$/;

export function groupIdentity(label: string): string {
  return label.toLowerCase();
}

export type ContentKeyFactory = (input: { name: string; groups: string[] }) => string;

/** One factory per collection per sync: duplicates are numbered in source order. */
export function createContentKeyFactory(): ContentKeyFactory {
  const seen = new Map<string, number>();
  return ({ name, groups }) => {
    const base = hashKey(`${name.toLowerCase()}\u0000${groups.map(groupIdentity).join(';')}`);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return occurrence === 1 ? base : `${base}-${occurrence}`;
  };
}

/** Key of an episode: unique per series + season + episode number. */
export function episodeKey(seriesKey: string, season: number, episode: number): string {
  return hashKey(`${seriesKey}\u0000s${season}\u0000e${episode}`);
}

export function hashKey(identity: string): string {
  return hash53(identity).toString(16).padStart(14, '0').slice(-12);
}

/**
 * cyrb53: fast, well-distributed 53-bit string hash. Not cryptographic — it only needs to be
 * stable and collision-resistant enough for ids within one source (a collision would merely
 * produce a `-2` suffix, never a wrong item). ~10x faster than sha1 on 100k entries.
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

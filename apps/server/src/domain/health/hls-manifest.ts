/**
 * Just enough HLS parsing to judge a live stream's health (not a player): which variant to
 * probe, whether the media playlist is alive (media sequence advancing) and which segment to
 * download. "HTTP 200" alone proves nothing — a frozen playlist also answers 200.
 */

export interface HlsVariant {
  uri: string;
  bandwidth: number;
}

export interface MediaPlaylist {
  mediaSequence: number;
  targetDurationSecs: number;
  segments: string[];
  endList: boolean;
  /** fMP4: the initialisation section (EXT-X-MAP) — segments are not decodable without it. */
  map: string | null;
}

export function isMasterPlaylistText(text: string): boolean {
  return /^#EXT-X-STREAM-INF:/m.test(text);
}

/** Variants of a master playlist (URIs as written; resolve against the playlist URL). */
export function parseVariants(text: string): HlsVariant[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const variants: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const bandwidth = Number(/(?:^|[,:])BANDWIDTH=(\d+)/.exec(line)?.[1] ?? Number.NaN);
    const uri = lines.slice(i + 1).find((next) => next && !next.startsWith('#'));
    if (uri) variants.push({ uri, bandwidth: Number.isFinite(bandwidth) ? bandwidth : Number.MAX_SAFE_INTEGER });
  }
  return variants;
}

/** The cheapest variant: probing must not cost the provider (or us) more than necessary. */
export function cheapestVariant(variants: readonly HlsVariant[]): HlsVariant | null {
  return [...variants].sort((a, b) => a.bandwidth - b.bandwidth)[0] ?? null;
}

export function parseMediaPlaylist(text: string): MediaPlaylist | null {
  if (!/^#EXTM3U/.test(text.trimStart())) return null;
  const mediaSequence = Number(/^#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/m.exec(text)?.[1] ?? 0);
  const targetDurationSecs = Number(/^#EXT-X-TARGETDURATION:\s*(\d+(?:\.\d+)?)/m.exec(text)?.[1] ?? Number.NaN);
  const segments = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!Number.isFinite(targetDurationSecs) || targetDurationSecs <= 0) return null;
  const map = /^#EXT-X-MAP:.*URI="([^"]+)"/m.exec(text)?.[1] ?? null;
  return { mediaSequence, targetDurationSecs, segments, endList: /^#EXT-X-ENDLIST\b/m.test(text), map };
}

export type LiveProgress = 'first' | 'advancing' | 'stalled';

/**
 * Is the live playlist moving? A live window slides: the media sequence (or the last segment)
 * must change within a few target durations. `previous` is what the last probe of this feed in
 * this region saw.
 */
export function liveProgress(
  previous: { mediaSequence: number; lastSegment: string | null; at: Date } | null,
  current: { mediaSequence: number; lastSegment: string | null; targetDurationSecs: number; at: Date },
): LiveProgress {
  if (!previous) return 'first';
  const moved = current.mediaSequence > previous.mediaSequence || (current.lastSegment !== null && current.lastSegment !== previous.lastSegment);
  if (moved) return 'advancing';
  // Allow 3 target durations (and at least 30 s) for the window to move.
  const allowanceMs = Math.max(30_000, current.targetDurationSecs * 3_000);
  return current.at.getTime() - previous.at.getTime() >= allowanceMs ? 'stalled' : 'advancing';
}

/** HTTP status → probe outcome (null = not an error status). */
export function outcomeOfStatus(status: number, bodyHint = ''): 'geo_blocked' | 'not_entitled' | 'http_error' | null {
  if (status < 400) return null;
  if (status === 451) return 'geo_blocked';
  if (status === 401 || status === 403) {
    // Panels and CDNs answer both "wrong account" and "not in your country" with 403; a body that
    // mentions the location tells them apart.
    return /\b(geo|country|region|territor|location)/i.test(bodyHint) ? 'geo_blocked' : 'not_entitled';
  }
  return 'http_error';
}

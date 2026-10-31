const URI_ATTRIBUTE = /URI="([^"]*)"/g;

/**
 * What a rewritten URI points to:
 *   playlist — another playlist (variants, renditions, I-frame playlists, LL-HLS rendition reports);
 *              players keep re-fetching these for the whole session;
 *   init     — an init section (EXT-X-MAP): players compare its URL across refreshes and
 *              re-initialise when it changes, so it must stay stable for the session;
 *   media    — segments, partial segments, keys, preload hints: fetched once, soon.
 */
export type HlsUriRole = 'playlist' | 'init' | 'media';

/** Tags whose URI attribute names a playlist; every other `URI="…"` is a media resource. */
const PLAYLIST_URI_TAGS = ['#EXT-X-MEDIA:', '#EXT-X-I-FRAME-STREAM-INF:', '#EXT-X-RENDITION-REPORT:'];

export function isMasterPlaylist(text: string): boolean {
  return /^#EXT-X-(?:I-FRAME-)?STREAM-INF:/m.test(text);
}

/** A media playlist that grows (live/event): its segments are only useful for a few minutes. */
export function isLiveMediaPlaylist(text: string): boolean {
  return !isMasterPlaylist(text) && !/^#EXT-X-ENDLIST\b/m.test(text) && !/^#EXT-X-PLAYLIST-TYPE:\s*VOD\b/m.test(text);
}

/**
 * Rewrites every URI in an HLS playlist (variant playlists, segments, keys, init segments,
 * alternative renditions, parts, preload hints) so it goes through the proxy.
 *
 * `baseUrl` must be the *final* URL of the playlist after redirects — relative URIs are
 * resolved against it exactly like a player would. Non-HTTP URIs (`data:`, `skd://`) are left
 * untouched.
 */
export function rewriteHlsPlaylist(
  text: string,
  baseUrl: URL,
  toProxyUri: (absoluteUrl: string, role: HlsUriRole) => string,
  options: { strict?: boolean } = {},
): string {
  const master = isMasterPlaylist(text);
  const strict = options.strict === true;
  const rewrite = (uri: string, role: HlsUriRole): string => {
    const trimmed = uri.trim();
    if (!trimmed) return uri;
    let absolute: URL;
    try {
      absolute = new URL(trimmed, baseUrl);
    } catch {
      return uri;
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return uri;
    return toProxyUri(absolute.href, role);
  };

  const lines: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    let output: string;
    if (!trimmed) {
      output = line;
    } else if (trimmed.startsWith('#')) {
      if (strict && !trimmed.startsWith('#EXT')) continue; // free-text comments may carry anything
      if (!trimmed.startsWith('#EXT') || !trimmed.includes('URI="')) {
        output = line;
      } else {
        const role: HlsUriRole = PLAYLIST_URI_TAGS.some((tag) => trimmed.startsWith(tag)) ? 'playlist' : trimmed.startsWith('#EXT-X-MAP:') ? 'init' : 'media';
        output = trimmed.replace(URI_ATTRIBUTE, (_match, uri: string) => `URI="${rewrite(uri, role)}"`);
      }
    } else {
      output = rewrite(trimmed, master ? 'playlist' : 'media');
    }
    // Strict (operator delivery): whatever could not be rewritten — absolute URLs in values
    // (EXT-X-DEFINE, SESSION-DATA, DATERANGE asset lists…) or unparsable URIs — is dropped, never
    // passed through to the viewer. Rewritten URIs are bare tokens and contain no scheme.
    if (strict && /[a-z][a-z0-9+.-]*:\/\//i.test(output.replace(/URI="skd:[^"]*"/gi, ''))) continue;
    if (strict && trimmed.startsWith('#EXT-X-DEFINE')) continue;
    lines.push(output);
  }
  return lines.join('\n');
}

/** True when the bytes are an HLS playlist (optionally preceded by a BOM / whitespace). */
export function looksLikeHlsPlaylist(head: Buffer): boolean {
  let text = head.subarray(0, 64).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.trimStart().startsWith('#EXTM3U');
}

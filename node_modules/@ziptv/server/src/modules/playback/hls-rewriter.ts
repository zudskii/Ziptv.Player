const URI_ATTRIBUTE = /URI="([^"]*)"/g;

/**
 * Rewrites every URI in an HLS playlist (variant playlists, segments, keys, init segments,
 * alternative renditions, parts, preload hints) so it goes through the proxy.
 *
 * `baseUrl` must be the *final* URL of the playlist after redirects — relative URIs are
 * resolved against it exactly like a player would. Non-HTTP URIs (`data:`, `skd://`) are left
 * untouched.
 */
export function rewriteHlsPlaylist(text: string, baseUrl: URL, toProxyUri: (absoluteUrl: string) => string): string {
  const rewrite = (uri: string): string => {
    const trimmed = uri.trim();
    if (!trimmed) return uri;
    let absolute: URL;
    try {
      absolute = new URL(trimmed, baseUrl);
    } catch {
      return uri;
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return uri;
    return toProxyUri(absolute.href);
  };

  return text
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return trimmed.startsWith('#EXT') && trimmed.includes('URI="')
          ? trimmed.replace(URI_ATTRIBUTE, (_match, uri: string) => `URI="${rewrite(uri)}"`)
          : line;
      }
      return rewrite(trimmed);
    })
    .join('\n');
}

/** True when the bytes are an HLS playlist (optionally preceded by a BOM / whitespace). */
export function looksLikeHlsPlaylist(head: Buffer): boolean {
  let text = head.subarray(0, 64).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.trimStart().startsWith('#EXTM3U');
}

import type { MediaUrls } from '../ports/media-urls.js';

/**
 * How artwork URLs (logos, posters, stills, user-set logos) leave the API.
 *   direct  — as stored; the client tries the URL itself and falls back to the image proxy;
 *   proxied — always an encrypted image-proxy path, so provider hosts never reach the client
 *             (operator delivery, `STREAM_DELIVERY=proxy`).
 */
export interface ArtworkUrls {
  url(raw: string | null): string | null;
}

export const directArtwork: ArtworkUrls = { url: (raw) => raw };

export function proxiedArtwork(media: Pick<MediaUrls, 'imageProxyPath'>): ArtworkUrls {
  return {
    url: (raw) => {
      if (!raw) return null;
      if (raw.startsWith('data:')) return raw;
      return /^https?:\/\//i.test(raw) ? media.imageProxyPath(raw) : null;
    },
  };
}

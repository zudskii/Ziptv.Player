import { config, resolveApiUrl } from '../config';

export type CatalogImageType = 'channel' | 'movie' | 'series';

/** Server image proxy for a catalog item (mixed content, hotlink protection). */
export function catalogImageProxy(sourceId: string, type: CatalogImageType, key: string): string {
  return resolveApiUrl(`/api/v1/media/images/${sourceId}/${type}/${key}`);
}

/**
 * Candidate URLs for an image, best first: direct (no server bandwidth) → server proxy.
 * http:// images are blocked (or silently upgraded and broken) on https pages, so those go
 * through the proxy only. API-relative paths (signed proxy URLs) are resolved against the API.
 */
export function imageSources(url: string | null | undefined, proxy?: string): string[] {
  if (!url) return [];
  if (url.startsWith('data:')) return [url];
  if (url.startsWith('/')) return [resolveApiUrl(url)];
  if (config.isSecurePage && url.startsWith('http:')) return proxy ? [proxy] : [];
  return proxy ? [url, proxy] : [url];
}

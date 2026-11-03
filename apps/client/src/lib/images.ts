import { config, resolveApiUrl } from '../config';

export type CatalogImageType = 'channel' | 'movie' | 'series';

/** Server image proxy for a catalog item (mixed content, hotlink protection). */
export function catalogImageProxy(sourceId: string, type: CatalogImageType, key: string): string {
  return resolveApiUrl(`/api/v1/media/images/${sourceId}/${type}/${key}`);
}

/**
 * Image candidates of a list/history item. Operator channels carry a ready URL (no per-source
 * proxy exists for them); everything else can fall back to the catalog image proxy.
 */
export function itemImageSources(image: string | null | undefined, item: { sourceId: string; type: CatalogImageType | 'operator'; key: string }): string[] {
  return imageSources(image, item.type === 'operator' ? undefined : catalogImageProxy(item.sourceId, item.type, item.key));
}

/** History entries: episodes show their series artwork. */
export function historyImageSources(item: { image: string | null; sourceId: string; contentType: string; key: string; seriesKey: string | null }): string[] {
  const type = item.contentType === 'operator' ? 'operator' : item.contentType === 'movie' ? 'movie' : item.contentType === 'episode' ? 'series' : 'channel';
  return itemImageSources(item.image, { sourceId: item.sourceId, type, key: item.contentType === 'episode' && item.seriesKey ? item.seriesKey : item.key });
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

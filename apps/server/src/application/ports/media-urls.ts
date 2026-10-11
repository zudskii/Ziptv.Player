import type { StreamHeaders } from '../../domain/catalog/model.js';

/** Builds signed, public media URLs (stream proxy, image proxy). */
export interface MediaUrls {
  /** Expiry (unix seconds) for a new playback plan. */
  newStreamExpiry(): number;
  streamProxyPath(url: string, headers: StreamHeaders, expiresAt: number): string;
  /** Signed proxy path for an arbitrary image URL (EPG icons); long-lived and CDN-cacheable. */
  imageProxyPath(url: string): string;
}

import type { StreamHeaders } from '../../domain/catalog/model.js';

/**
 * What keeps a proxied stream link alive. The proxy re-checks it (cached briefly), so signing
 * out a device or revoking an export link stops its streams within seconds, not at token expiry.
 *   session — the signed-in device that requested the playback plan;
 *   export  — a playlist export link (id = hash of the link token).
 */
export interface MediaGrant {
  kind: 'session' | 'export';
  id: string;
}

/** Builds encrypted, public media URLs (stream proxy, image proxy). */
export interface MediaUrls {
  /** Expiry (unix seconds) for a new playback plan, or for links written into an exported playlist. */
  newStreamExpiry(use?: 'playback' | 'export'): number;
  /** Path (relative to the API origin) of the stream proxy for one upstream URL. */
  streamProxyPath(url: string, headers: StreamHeaders, expiresAt: number, grant: MediaGrant): string;
  /** Proxy path for an arbitrary image URL (artwork, guide icons); long-lived and CDN-cacheable. */
  imageProxyPath(url: string): string;
}

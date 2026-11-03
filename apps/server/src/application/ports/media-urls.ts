import type { CatchupInfo, StreamHeaders } from '../../domain/catalog/model.js';

/**
 * What keeps a proxied stream link alive. The proxy re-checks it (cached briefly), so signing
 * out a device or revoking an export link stops its streams within seconds, not at token expiry.
 *   session — the signed-in device that requested the playback plan;
 *   export  — a playlist export link (id = hash of the link token).
 */
export interface MediaGrant {
  /** session = signed-in device; export = playlist link; playback = an authorized operator viewing. */
  kind: 'session' | 'export' | 'playback';
  id: string;
}

/** Builds encrypted, public media URLs (stream proxy, image proxy). */
export interface MediaUrls {
  /** Expiry (unix seconds) for a new playback plan, or for links written into an exported playlist. */
  newStreamExpiry(use?: 'playback' | 'export'): number;
  /** Path (relative to the API origin) of the stream proxy for one upstream URL. */
  streamProxyPath(url: string, headers: StreamHeaders, expiresAt: number, grant: MediaGrant): string;
  /**
   * Catch-up template (path relative to the API origin, with `{utc}` / `{utcend}` placeholders)
   * for an exported channel: the player fills in the programme, the server builds the archive
   * URL and redirects into the stream proxy. Provider addresses never reach the player.
   */
  archiveProxyTemplate(url: string, headers: StreamHeaders, catchup: CatchupInfo, expiresAt: number, grant: MediaGrant): string;
  /** Proxy path for an arbitrary image URL (artwork, guide icons); long-lived and CDN-cacheable. */
  imageProxyPath(url: string): string;
}

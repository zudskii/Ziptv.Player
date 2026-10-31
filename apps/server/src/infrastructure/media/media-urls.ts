import type { MediaGrant, MediaUrls } from '../../application/ports/media-urls.js';
import type { StreamHeaders } from '../../domain/catalog/model.js';
import type { MediaTokenCodec } from '../crypto/media-token.js';

/** Public URL layout of the media proxies — the only place their paths are built. */
export class SignedMediaUrls implements MediaUrls {
  constructor(
    private readonly tokens: MediaTokenCodec,
    private readonly mediaPrefix: string,
    private readonly exportTtlSeconds: number,
  ) {}

  newStreamExpiry(use: 'playback' | 'export' = 'playback'): number {
    return use === 'export' ? this.tokens.newExpiry(this.exportTtlSeconds) : this.tokens.newExpiry();
  }

  streamProxyPath(url: string, headers: StreamHeaders, expiresAt: number, grant: MediaGrant): string {
    return `${this.mediaPrefix}/stream/${this.tokens.issue(url, headers, expiresAt, grant)}`;
  }

  imageProxyPath(url: string): string {
    return `${this.mediaPrefix}/images/t/${this.tokens.issueImage(url)}`;
  }
}

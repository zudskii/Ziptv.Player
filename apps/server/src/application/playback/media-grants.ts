import { isEntityId } from '../../domain/shared/ids.js';
import type { Cache } from '../ports/cache.js';
import type { Clock } from '../ports/clock.js';
import type { MediaGrant } from '../ports/media-urls.js';
import type { PlaylistRepository } from '../ports/playlist-repository.js';
import type { SessionRepository } from '../ports/session-repository.js';

/**
 * How long a grant decision is reused. Bounds how long a revoked device/export link keeps
 * streaming (and the database load: one lookup per grant per instance per window, however many
 * segments the player fetches).
 */
export const GRANT_CHECK_TTL_MS = 30_000;

const HASH = /^[a-f0-9]{64}$/;

export function grantCacheKey(grant: MediaGrant): string {
  return `grant:${grant.kind}:${grant.id}`;
}

/**
 * Re-validates what a proxied stream link was issued for. A link is a bearer credential that
 * lives for hours; without this, signing out, deleting a device or revoking an export link would
 * not stop streams that already have links.
 */
export class MediaGrantChecker {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      playlists: PlaylistRepository;
      cache: Cache;
      clock: Clock;
      /** Export grants are only honoured while exports are proxied (switching to `off` kills issued links). */
      exportMode: 'direct' | 'proxied' | 'off';
    },
  ) {}

  isActive(grant: MediaGrant): Promise<boolean> {
    return this.deps.cache.wrap(grantCacheKey(grant), GRANT_CHECK_TTL_MS, () => this.lookup(grant));
  }

  /** Forget a cached decision now (logout, export link revoked) instead of waiting for the TTL. */
  forget(grant: MediaGrant): void {
    this.deps.cache.delete(grantCacheKey(grant));
  }

  private async lookup(grant: MediaGrant): Promise<boolean> {
    switch (grant.kind) {
      case 'session':
        return isEntityId(grant.id) && this.deps.sessions.isActive(grant.id, this.deps.clock.now());
      case 'export': {
        if (this.deps.exportMode !== 'proxied' || !HASH.test(grant.id)) return false;
        const playlist = await this.deps.playlists.findByExportTokenHash(grant.id);
        return playlist !== null && playlist.exportEnabled;
      }
    }
  }
}

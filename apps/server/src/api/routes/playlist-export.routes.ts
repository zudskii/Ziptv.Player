import { once } from 'node:events';

import cors from 'cors';
import { Router } from 'express';

import { AppError } from '../../application/errors.js';
import type { PlaylistExportService } from '../../application/playlists/playlist-export.service.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { routeParam } from '../middleware/request-context.js';

/** `<43-char token>.m3u` (or `.m3u8`: some players insist on it). */
const FILE = /^([A-Za-z0-9_-]{43})\.m3u8?$/i;

/**
 * GET /p/<token>.m3u — the playlist as a file, for any player. No session: whoever holds the
 * link may read it, so the link is a secret (revocable by its owner). Unknown, malformed and
 * revoked links all answer the same 404.
 */
export function createPlaylistExportRouter(exporter: PlaylistExportService, options: { publicUrl: string | null; limit: RateLimiterFactory }): Router {
  const router = Router();
  // Players and browser-based apps fetch it from anywhere; the token is the only credential.
  router.use(cors({ origin: '*', methods: ['GET', 'HEAD'], maxAge: 86_400 }));
  router.use(options.limit({ name: 'export', windowMs: 60_000, limit: 60 }));

  router.get('/:file', async (req, res) => {
    const match = FILE.exec(routeParam(req, 'file'));
    const origin = options.publicUrl ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`;
    const opened = match ? await exporter.open(match[1]!, origin) : null;
    if (!opened) throw AppError.notFound('Playlist');

    res.status(200);
    res.setHeader('Content-Type', opened.contentType);
    res.setHeader('Content-Disposition', 'inline; filename="playlist.m3u"');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    try {
      for await (const chunk of opened.chunks()) {
        if (res.destroyed) return; // the player went away
        if (!res.write(chunk)) await once(res, 'drain');
      }
      res.end();
    } catch (error) {
      // Headers are out, so a JSON error is impossible: cut the connection so the player
      // sees a failed download instead of a silently truncated playlist.
      res.destroy(error instanceof Error ? error : undefined);
    }
  });

  return router;
}

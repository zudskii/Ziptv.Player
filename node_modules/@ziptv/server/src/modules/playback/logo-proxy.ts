import type { RequestHandler, Response } from 'express';

import { firstHeader, type UpstreamClient } from '../../infrastructure/http/upstream-client.js';
import type { Logger } from '../../infrastructure/logger.js';
import { routeParam } from '../../shared/http/request-context.js';
import type { PlaylistService } from '../playlists/playlist.service.js';

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const CHANNEL_KEY = /^[a-f0-9]{12}(-\d{1,6})?$/;

/**
 * GET /logos/:playlistId/:channelKey — serves a channel logo through the server.
 *
 * Needed because http:// logos are blocked on https pages and many logo hosts hotlink-protect.
 * Only logos that exist in a stored playlist can be fetched (no arbitrary URL parameter).
 * Responses are long-cacheable so a CDN (Cloudflare) absorbs almost all traffic.
 */
export function createLogoProxyHandler(deps: { playlists: PlaylistService; upstream: UpstreamClient; logger: Logger }): RequestHandler {
  return async (req, res) => {
    const playlistId = routeParam(req, 'playlistId');
    const channelKey = routeParam(req, 'channelKey');
    if (!CHANNEL_KEY.test(channelKey)) return notFound(res);

    const logo = await deps.playlists.findChannelLogo(playlistId, channelKey);
    if (!logo || logo.startsWith('data:')) return notFound(res);

    try {
      const { bytes, response } = await deps.upstream.fetchBytes(logo, MAX_LOGO_BYTES, {
        headers: { accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8' },
        signal: AbortSignal.timeout(10_000),
      });
      const type = detectImageType(bytes) ?? imageContentType(firstHeader(response.headers['content-type']));
      if (!type) return notFound(res);

      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      // SVG can carry scripts: never let a logo execute anything if opened directly.
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(bytes);
    } catch (error) {
      deps.logger.debug({ err: error, playlistId, channelKey }, 'Logo fetch failed');
      notFound(res);
    }
  };
}

function notFound(res: Response): void {
  // Cache misses briefly so a broken logo is not re-fetched on every render.
  res.status(404).setHeader('Cache-Control', 'public, max-age=600').end();
}

function imageContentType(value: string | undefined): string | null {
  const type = value?.split(';')[0]?.trim().toLowerCase();
  return type?.startsWith('image/') ? type : null;
}

export function detectImageType(bytes: Buffer): string | null {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (bytes.subarray(4, 12).toString('latin1') === 'ftypavif') return 'image/avif';
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/x-icon';
  const head = bytes.subarray(0, 1024).toString('utf8').toLowerCase();
  if (head.includes('<svg')) return 'image/svg+xml';
  return null;
}

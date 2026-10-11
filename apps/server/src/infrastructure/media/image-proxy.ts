import type { RequestHandler, Response } from 'express';

import type { Logger } from '../../application/ports/logger.js';
import type { MediaTokenCodec } from '../crypto/media-token.js';
import { firstHeader, type UpstreamClient } from '../http/upstream-client.js';

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const KEY = /^[a-f0-9]{12}(-\d{1,6})?$/;
const TYPES = new Set(['channel', 'movie', 'series']);

export type ImageLookup = (sourceId: string, type: 'channel' | 'movie' | 'series', key: string) => Promise<string | null>;

interface ImageProxyDeps {
  lookup: ImageLookup;
  tokens: MediaTokenCodec;
  upstream: UpstreamClient;
  logger: Logger;
}

/**
 * Images through the server (logos, posters, covers, guide icons).
 *
 * Needed because http:// images are blocked on https pages and many hosts hotlink-protect.
 * Two forms, neither accepts an arbitrary URL:
 *   /images/:sourceId/:type/:key — an image that exists in a stored catalog;
 *   /images/t/:token            — a URL signed by the server (guide icons, episode stills).
 * Responses are long-cacheable so a CDN (Cloudflare) absorbs almost all traffic.
 */
export function createCatalogImageHandler(deps: ImageProxyDeps): RequestHandler {
  return async (req, res) => {
    const sourceId = String(req.params.sourceId ?? '');
    const type = String(req.params.type ?? '');
    const key = String(req.params.key ?? '');
    if (!/^[a-f0-9]{24}$/i.test(sourceId) || !TYPES.has(type) || !KEY.test(key)) return notFound(res);
    const url = await deps.lookup(sourceId, type as 'channel' | 'movie' | 'series', key);
    await serve(deps, res, url);
  };
}

export function createSignedImageHandler(deps: ImageProxyDeps): RequestHandler {
  return async (req, res) => {
    const payload = deps.tokens.verify(String(req.params.token ?? ''), 'image');
    await serve(deps, res, payload?.u ?? null);
  };
}

async function serve(deps: ImageProxyDeps, res: Response, url: string | null): Promise<void> {
  if (!url || url.startsWith('data:')) return notFound(res);
  try {
    const { bytes, response } = await deps.upstream.fetchBytes(url, MAX_IMAGE_BYTES, {
      headers: { accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8' },
      signal: AbortSignal.timeout(10_000),
    });
    const type = detectImageType(bytes) ?? imageContentType(firstHeader(response.headers['content-type']));
    if (!type) return notFound(res);

    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    // SVG can carry scripts: never let an image execute anything if opened directly.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(bytes);
  } catch (error) {
    deps.logger.debug({ err: error }, 'Image fetch failed');
    notFound(res);
  }
}

function notFound(res: Response): void {
  // Cache misses briefly so a broken image is not re-fetched on every render.
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

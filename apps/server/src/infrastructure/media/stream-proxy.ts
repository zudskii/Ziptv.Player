import { pipeline } from 'node:stream/promises';

import type { Request, RequestHandler, Response } from 'express';

import {
  decodeContent,
  firstHeader,
  isContentEncoded,
  UpstreamError,
  type UpstreamClient,
  type UpstreamResponse,
} from '../http/upstream-client.js';
import { AppError } from '../../application/errors.js';
import type { Logger } from '../../application/ports/logger.js';
import type { MediaGrant } from '../../application/ports/media-urls.js';
import type { MediaTokenCodec } from '../crypto/media-token.js';
import { destroyQuietly } from '../streams/destroy.js';
import { collect, peekStream, rejoin } from '../streams/peek.js';
import { isLiveMediaPlaylist, looksLikeHlsPlaylist, rewriteHlsPlaylist } from './hls-rewriter.js';

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const SNIFF_BYTES = 64;
/**
 * Segments/keys of a *live* playlist are fetched within seconds; their links die 10–15 minutes
 * after issue. Expiry is bucketed (5 min) so refreshes of the same playlist keep identical URLs.
 */
export const LIVE_MEDIA_TOKEN_TTL_SECONDS = 10 * 60;
const LIVE_MEDIA_BUCKET_SECONDS = 5 * 60;

export function liveMediaExpiry(now: number, grantExpiry: number): number {
  const bucketed = Math.ceil((now + LIVE_MEDIA_TOKEN_TTL_SECONDS) / LIVE_MEDIA_BUCKET_SECONDS) * LIVE_MEDIA_BUCKET_SECONDS;
  return Math.min(grantExpiry, bucketed);
}
const PASSTHROUGH_HEADERS = ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control', 'expires'];

interface StreamProxyDeps {
  tokens: MediaTokenCodec;
  /** Is the device / export link the token was issued for still allowed to stream? */
  grants: { isActive(grant: MediaGrant): Promise<boolean> };
  upstream: UpstreamClient;
  logger: Logger;
  /** Operator delivery: drop manifest lines that could reveal the upstream (see rewriteHlsPlaylist). */
  strictManifests?: boolean;
}

/**
 * GET /stream/:token — streaming reverse proxy for one upstream URL named by an encrypted token.
 *
 * - The token's grant (signed-in device or export link) is re-checked, so revoked links stop.
 * - Error responses never name the upstream host: the viewer must not learn the provider.
 * - HLS playlists (detected by content, not by the often-wrong Content-Type) are rewritten so
 *   every nested URI becomes another signed proxy URL. Rewritten URIs are *relative* (the bare
 *   token): they resolve next to the current URL, so the proxy works behind any path prefix
 *   or origin without configuration.
 * - Everything else (segments, keys, continuous MPEG-TS/FLV, MP4 with Range) is piped with
 *   backpressure; the upstream request is aborted as soon as the viewer disconnects.
 */
export function createStreamProxyHandler(deps: StreamProxyDeps): RequestHandler {
  return async (req, res) => {
    const token = deps.tokens.verify(String(req.params.token ?? ''), 'stream');
    if (!token?.grant) throw new AppError('FORBIDDEN', 403, 'Stream link is invalid or expired. Request a new playback plan.');
    const grant = token.grant;
    if (!(await deps.grants.isActive(grant))) throw new AppError('FORBIDDEN', 403, 'Stream link was revoked. Request a new playback plan.');

    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const headers: Record<string, string> = { ...token.headers };
    const range = req.headers.range;
    if (typeof range === 'string' && /^bytes=\d*-\d*$/.test(range)) headers.range = range;

    let upstream: UpstreamResponse;
    try {
      upstream = await deps.upstream.request(token.url, { headers, signal: abort.signal });
    } catch (error) {
      if (abort.signal.aborted) return;
      throw toProxyError(error, deps.logger);
    }

    if (upstream.status >= 400) {
      destroyQuietly(upstream.body);
      res.setHeader('X-Upstream-Status', String(upstream.status));
      throw new AppError('UPSTREAM_ERROR', upstream.status < 500 ? upstream.status : 502, `Stream source answered HTTP ${upstream.status}.`, {
        upstreamStatus: upstream.status,
      });
    }

    const encoding = firstHeader(upstream.headers['content-encoding']);
    const decoded = isContentEncoded(encoding);
    const body = decoded ? decodeContent(upstream.body, encoding) : upstream.body;

    try {
      const peeked = await peekStream(body, SNIFF_BYTES);

      if (looksLikeHlsPlaylist(peeked.head)) {
        const manifest = await collect(peeked, MAX_MANIFEST_BYTES);
        if (!manifest) throw new AppError('UPSTREAM_ERROR', 502, 'Stream playlist is too large.');
        const text = manifest.toString('utf8');
        const mediaExpiry = isLiveMediaPlaylist(text) ? liveMediaExpiry(deps.tokens.now(), token.expiresAt) : token.expiresAt;
        const rewritten = rewriteHlsPlaylist(text, upstream.url, (absoluteUrl, role) =>
          deps.tokens.issue(absoluteUrl, token.headers, role === 'media' ? mediaExpiry : token.expiresAt, grant),
          { strict: deps.strictManifests === true },
        );
        res.status(200);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.end(rewritten);
        return;
      }

      writeMediaHeaders(res, upstream, decoded);
      await pipeline(rejoin(peeked), res);
    } catch (error) {
      if (abort.signal.aborted || res.destroyed) return; // viewer left mid-stream: normal
      if (res.headersSent) {
        deps.logger.debug({ err: error }, 'Stream proxy interrupted');
        res.destroy();
        return;
      }
      throw error instanceof AppError ? error : toProxyError(error, deps.logger);
    } finally {
      destroyQuietly(body);
      destroyQuietly(upstream.body);
    }
  };
}

function writeMediaHeaders(res: Response, upstream: UpstreamResponse, decoded: boolean): void {
  res.status(upstream.status);
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers[name];
    if (value !== undefined) res.setHeader(name, value);
  }
  // After decompression the upstream length is wrong; otherwise keep it (players use it for MP4 seeking).
  const length = firstHeader(upstream.headers['content-length']);
  if (!decoded && length) res.setHeader('Content-Length', length);
  if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/octet-stream');
}

/** Upstream messages name hosts/addresses: they go to the log, the viewer gets a generic reason. */
function toProxyError(error: unknown, logger: Logger): AppError {
  logger.debug({ err: error }, 'Stream proxy upstream failure');
  if (error instanceof UpstreamError) {
    switch (error.kind) {
      case 'blocked':
        return new AppError('UPSTREAM_BLOCKED', 403, 'Stream points to a private network address.');
      case 'timeout':
        return new AppError('UPSTREAM_ERROR', 504, 'Stream source did not answer in time.');
      case 'too_large':
        return new AppError('UPSTREAM_ERROR', 502, 'Stream source sent more data than allowed.');
      default:
        return new AppError('UPSTREAM_ERROR', 502, 'Stream source could not be reached.');
    }
  }
  return new AppError('UPSTREAM_ERROR', 502, 'Stream source failed.');
}

/** Proxy URLs are fetched by media elements/XHR from other origins; tokens are the auth. */
export function mediaCorsHeaders(_req: Request, res: Response, next: () => void): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, X-Upstream-Status');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}

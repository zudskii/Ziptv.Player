import { pipeline } from 'node:stream/promises';

import type { Request, RequestHandler, Response } from 'express';

import {
  decodeContent,
  firstHeader,
  isContentEncoded,
  UpstreamError,
  type UpstreamClient,
  type UpstreamResponse,
} from '../../infrastructure/http/upstream-client.js';
import type { Logger } from '../../infrastructure/logger.js';
import { AppError } from '../../shared/errors.js';
import { routeParam } from '../../shared/http/request-context.js';
import { destroyQuietly } from '../../shared/streams/destroy.js';
import { collect, peekStream, rejoin } from '../../shared/streams/peek.js';
import { looksLikeHlsPlaylist, rewriteHlsPlaylist } from './hls-rewriter.js';
import type { StreamTokenCodec } from './stream-token.js';

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const SNIFF_BYTES = 64;
const PASSTHROUGH_HEADERS = ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control', 'expires'];

interface StreamProxyDeps {
  tokens: StreamTokenCodec;
  upstream: UpstreamClient;
  logger: Logger;
}

/**
 * GET /stream/:token — streaming reverse proxy for one signed upstream URL.
 *
 * - HLS playlists (detected by content, not by the often-wrong Content-Type) are rewritten so
 *   every nested URI becomes another signed proxy URL. Rewritten URIs are *relative* (the bare
 *   token): they resolve next to the current URL, so the proxy works behind any path prefix
 *   or origin without configuration.
 * - Everything else (segments, keys, continuous MPEG-TS/FLV, MP4 with Range) is piped with
 *   backpressure; the upstream request is aborted as soon as the viewer disconnects.
 */
export function createStreamProxyHandler(deps: StreamProxyDeps): RequestHandler {
  return async (req, res) => {
    const payload = deps.tokens.verify(routeParam(req, 'token'));
    if (!payload) throw new AppError('FORBIDDEN', 403, 'Stream link is invalid or expired. Request a new playback plan.');

    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const headers: Record<string, string> = { ...payload.h };
    const range = req.headers.range;
    if (typeof range === 'string' && /^bytes=\d*-\d*$/.test(range)) headers.range = range;

    let upstream: UpstreamResponse;
    try {
      upstream = await deps.upstream.request(payload.u, { headers, signal: abort.signal });
    } catch (error) {
      if (abort.signal.aborted) return;
      throw toProxyError(error);
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
        const rewritten = rewriteHlsPlaylist(manifest.toString('utf8'), upstream.url, (absoluteUrl) =>
          deps.tokens.issue(absoluteUrl, payload.h, payload.e),
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
      throw error instanceof AppError ? error : toProxyError(error);
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

function toProxyError(error: unknown): AppError {
  if (error instanceof UpstreamError) {
    switch (error.kind) {
      case 'blocked':
        return new AppError('UPSTREAM_BLOCKED', 403, 'Stream points to a private network address.');
      case 'timeout':
        return new AppError('UPSTREAM_ERROR', 504, 'Stream source did not answer in time.');
      default:
        return new AppError('UPSTREAM_ERROR', 502, error.message);
    }
  }
  return new AppError('UPSTREAM_ERROR', 502, 'Stream source failed.', undefined, { cause: error });
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

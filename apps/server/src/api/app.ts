import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import type { Logger } from '../application/ports/logger.js';
import type { AppConfig } from '../config/env.js';
import type { Container } from '../container.js';
import { API_PREFIX, MEDIA_PREFIX, PLAYLIST_EXPORT_PREFIX } from './http-paths.js';
import { acceptBodyUnlock, optionalSession, requireSession } from './middleware/auth.js';
import { createPlaylistExportRouter } from './routes/playlist-export.routes.js';
import { createErrorHandler, notFoundHandler } from './middleware/error-handler.js';
import { rateLimiterFactory } from './middleware/rate-limit.js';
import { createApiRouters } from './routes/index.js';
import { createMediaRouter } from './routes/media.routes.js';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  container: Container;
  /** Readiness probe: should answer false while the database is unreachable. */
  isReady: () => boolean | Promise<boolean>;
}

/** HTTP layer only: middleware order, routing and error handling. No business logic here. */
export function createApp({ config, logger, container, isReady }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.http.trustProxy);
  const limit = rateLimiterFactory(container.rateLimitStores);

  app.use(
    pinoHttp({
      logger: logger as never,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Segment/image traffic would drown the logs; errors are still logged by the error handler.
      autoLogging: { ignore: (req) => (req.url ?? '').startsWith(MEDIA_PREFIX) || (req.url ?? '').startsWith('/health') || (req.url ?? '').startsWith('/ready') },
      customLogLevel: (_req, res, error) => (error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req: { method: string; url: string; id: unknown }) => ({ id: req.id, method: req.method, url: redactUrl(req.url) }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: { useDefaults: false, directives: contentSecurityPolicy(config.stream.delivery) },
    }),
  );

  // --- Probes (for Docker/Render/K8s) -------------------------------------------------------
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', async (_req, res) => {
    const ready = await isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  // --- Public media (stream proxy + images): CORS *, signed tokens as auth ------------------
  app.use(
    MEDIA_PREFIX,
    createMediaRouter({
      cors: container.media.cors,
      streamProxy: config.stream.proxyEnabled ? container.media.streamProxy : null,
      catalogImages: container.media.catalogImages,
      signedImages: container.media.signedImages,
      limit,
    }),
  );

  // --- Public playlist links: the token in the URL is the credential ----------------------------
  app.use(PLAYLIST_EXPORT_PREFIX, createPlaylistExportRouter(container.playlistExport, { publicUrl: config.publicUrl, limit }));

  // --- JSON API ------------------------------------------------------------------------------
  const auth = requireSession(container.sessions, container.viewers);
  const api = express.Router();
  api.use(
    cors({
      origin: config.http.corsOrigins.includes('*') ? '*' : config.http.corsOrigins.length ? config.http.corsOrigins : false,
      allowedHeaders: ['Authorization', 'Content-Type', 'If-None-Match', 'X-Request-Id', 'X-Profile-Id', 'X-Unlock-Token'],
      exposedHeaders: ['ETag', 'X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 86_400,
    }),
  );
  api.use(compression());
  api.use(express.json({ limit: '256kb' }));
  api.use(limit({ name: 'api', windowMs: 60 * 1000, limit: 900 }));
  api.use(createApiRouters({ container, auth, optionalAuth: optionalSession(container.sessions), withUnlock: acceptBodyUnlock(container.viewers), config, limit }));
  api.use(notFoundHandler);
  app.use(API_PREFIX, api);

  if (config.http.clientDistDir) serveClient(app, config.http.clientDistDir, logger);

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}

/**
 * `auto` delivery: the player loads media, images and manifests from arbitrary provider hosts,
 * so those directives are open while scripts stay same-origin. No `upgrade-insecure-requests`:
 * it would silently rewrite direct http:// stream URLs to https and break them.
 * `proxy` delivery: every stream and image comes from this origin, so the page may not talk to
 * anything else (an injected script could not exfiltrate to, or a stream leak to, another host).
 */
function contentSecurityPolicy(delivery: 'auto' | 'proxy') {
  const open = delivery === 'auto';
  return {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  imgSrc: open ? ['*', 'data:', 'blob:'] : ["'self'", 'data:', 'blob:'],
  mediaSrc: open ? ['*', 'data:', 'blob:'] : ["'self'", 'data:', 'blob:'],
  connectSrc: open ? ['*'] : ["'self'"],
  workerSrc: ["'self'", 'blob:'],
  fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  };
}

/** Optional single-origin deployment: static client + SPA fallback for non-API routes. */
function serveClient(app: Express, directory: string, logger: Logger): void {
  const root = path.resolve(directory);
  const indexHtml = path.join(root, 'index.html');
  if (!existsSync(indexHtml)) {
    logger.warn({ root }, 'CLIENT_DIST_DIR has no index.html — client is not served');
    return;
  }
  // Hashed build assets never change; index.html must always be revalidated.
  app.use('/assets', express.static(path.join(root, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
  app.use(express.static(root, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/|healthz|readyz).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
  logger.info({ root }, 'Serving client build');
}

/** Keeps tokens out of access logs. */
function redactUrl(url: string): string {
  return url.replace(/(\/media\/(?:stream|images\/t)\/)[^/?]+/, '$1[token]').replace(new RegExp(`^${PLAYLIST_EXPORT_PREFIX}/[^/?]+`), `${PLAYLIST_EXPORT_PREFIX}/[token]`);
}

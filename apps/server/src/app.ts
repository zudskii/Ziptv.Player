import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import type { AppConfig } from './config/env.js';
import type { Container } from './container.js';
import { API_PREFIX, MEDIA_PREFIX } from './http-paths.js';
import type { Logger } from './infrastructure/logger.js';
import { createLogoProxyHandler } from './modules/playback/logo-proxy.js';
import { createMediaRouter, createPlaybackRouter } from './modules/playback/playback.routes.js';
import { createStreamProxyHandler, mediaCorsHeaders } from './modules/playback/stream-proxy.js';
import { createPlaylistRouter } from './modules/playlists/playlist.routes.js';
import { createSessionRouter, requireSession } from './modules/session/session.routes.js';
import { createErrorHandler, notFoundHandler } from './shared/http/error-handler.js';
import { createRateLimiter } from './shared/http/rate-limit.js';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  container: Pick<Container, 'sessions' | 'playlists' | 'playback' | 'upstream' | 'tokens'>;
  isReady: () => boolean;
}

/** HTTP layer only: middleware order, routing and error handling. No business logic here. */
export function createApp({ config, logger, container, isReady }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.http.trustProxy);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Segment/logo traffic would drown the logs; errors are still logged by the error handler.
      autoLogging: { ignore: (req) => (req.url ?? '').startsWith(MEDIA_PREFIX) || (req.url ?? '').startsWith('/health') },
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
      contentSecurityPolicy: { useDefaults: false, directives: CONTENT_SECURITY_POLICY },
    }),
  );

  // --- Probes (for Docker/Render/K8s) -------------------------------------------------------
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', (_req, res) => {
    const ready = isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  // --- Public media (stream proxy + logos): CORS *, signed tokens as auth -------------------
  app.use(
    MEDIA_PREFIX,
    createMediaRouter({
      cors: mediaCorsHeaders,
      streamProxy: config.stream.proxyEnabled
        ? createStreamProxyHandler({ tokens: container.tokens, upstream: container.upstream, logger })
        : null,
      logoProxy: createLogoProxyHandler({ playlists: container.playlists, upstream: container.upstream, logger }),
    }),
  );

  // --- JSON API ------------------------------------------------------------------------------
  const auth = requireSession(container.sessions);
  const api = express.Router();
  api.use(
    cors({
      origin: config.http.corsOrigins.includes('*') ? '*' : config.http.corsOrigins.length ? config.http.corsOrigins : false,
      allowedHeaders: ['Authorization', 'Content-Type', 'If-None-Match', 'X-Request-Id'],
      exposedHeaders: ['ETag', 'X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 86_400,
    }),
  );
  api.use(compression());
  api.use(express.json({ limit: '64kb' }));
  api.use(createRateLimiter({ windowMs: 60 * 1000, limit: 600 }));

  api.use('/sessions', createSessionRouter(container.sessions, auth));
  api.use('/playlists', createPlaylistRouter({ playlists: container.playlists, auth, maxPlaylistBytes: config.limits.maxPlaylistBytes }));
  api.use('/playback', createPlaybackRouter({ playback: container.playback, auth }));
  api.use(notFoundHandler);
  app.use(API_PREFIX, api);

  if (config.http.clientDistDir) serveClient(app, config.http.clientDistDir, logger);

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}

/**
 * The player loads media, logos and manifests from arbitrary provider hosts, so those
 * directives are open while scripts stay same-origin. No `upgrade-insecure-requests`: it would
 * silently rewrite direct http:// stream URLs to https and break them.
 */
const CONTENT_SECURITY_POLICY = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ['*', 'data:', 'blob:'],
  mediaSrc: ['*', 'data:', 'blob:'],
  connectSrc: ['*'],
  workerSrc: ["'self'", 'blob:'],
  fontSrc: ["'self'", 'data:'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

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
  return url.replace(/(\/media\/stream\/)[^/?]+/, '$1[token]');
}

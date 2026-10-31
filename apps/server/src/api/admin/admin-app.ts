import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import type { Logger } from '../../application/ports/logger.js';
import type { AppConfig } from '../../config/env.js';
import type { Container } from '../../container.js';
import { createErrorHandler, notFoundHandler } from '../middleware/error-handler.js';
import { rateLimiterFactory } from '../middleware/rate-limit.js';
import { createAdminRoutes } from './admin.routes.js';

export const ADMIN_API_PREFIX = '/admin/v1';

/**
 * The operator console on its own listener (ADMIN_PORT): a different origin from the public app,
 * so it can be firewalled/VPN-only, its cookies/storage never mix with viewers', and the public
 * listener has no admin routes at all. Same-origin only (no CORS), strict CSP, no caching.
 */
export function createAdminApp({ config, logger, container }: { config: AppConfig; logger: Logger; container: Container }): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.admin.trustProxy);
  app.use(
    pinoHttp({
      logger: logger as never,
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => !(req.url ?? '').startsWith(ADMIN_API_PREFIX) },
      serializers: {
        req: (req: { method: string; url: string; id: unknown }) => ({ id: req.id, method: req.method, url: req.url.split('?')[0] }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const limit = rateLimiterFactory(container.rateLimitStores);
  const routes = createAdminRoutes(container.admin, limit);
  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(express.json({ limit: '64kb' }));
  api.use(limit({ name: 'admin:api', windowMs: 60_000, limit: 600 }));
  api.use(routes.router);
  api.use(notFoundHandler);
  app.use(ADMIN_API_PREFIX, api);

  if (config.admin.distDir) serveConsole(app, config.admin.distDir, logger);
  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return Object.assign(app, { adminRoutes: routes.routes });
}

function serveConsole(app: Express, directory: string, logger: Logger): void {
  const root = path.resolve(directory);
  const indexHtml = path.join(root, 'index.html');
  if (!existsSync(indexHtml)) {
    logger.warn({ root }, 'ADMIN_DIST_DIR has no index.html — console UI is not served');
    return;
  }
  app.use('/assets', express.static(path.join(root, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
  app.use(express.static(root, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!admin\/v1\/|healthz).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
  logger.info({ root }, 'Serving operator console');
}

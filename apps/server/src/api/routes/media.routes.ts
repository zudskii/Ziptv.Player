import { Router, type RequestHandler } from 'express';

import { createRateLimiter } from '../middleware/rate-limit.js';

/**
 * Public media routes (stream proxy + images). No session: `<video>`/`<img>` and hls.js cannot
 * send our Authorization header, so access is granted by signed tokens / stored catalogs.
 */
export function createMediaRouter(deps: {
  cors: RequestHandler;
  streamProxy: RequestHandler | null;
  catalogImages: RequestHandler;
  signedImages: RequestHandler;
}): Router {
  const router = Router();
  // Generous: one viewer fetches a segment (and sometimes a playlist) every 2–6 s per rendition.
  const streamLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 1500 });
  const imageLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 1200 });

  router.use(deps.cors);
  router.options('/{*any}', (_req, res) => {
    res.status(204).end();
  });

  if (deps.streamProxy) router.get('/stream/:token', streamLimiter, deps.streamProxy);
  router.get('/images/t/:token', imageLimiter, deps.signedImages);
  router.get('/images/:sourceId/:type/:key', imageLimiter, deps.catalogImages);
  // 2.x logo URLs (playlist id = source id after the 3.0 migration).
  router.get('/logos/:sourceId/:key', imageLimiter, (req, _res, next) => {
    req.params.type = 'channel';
    next();
  }, deps.catalogImages);

  return router;
}

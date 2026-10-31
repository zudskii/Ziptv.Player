import { Router, type RequestHandler } from 'express';

import type { VodCatalogService } from '../../application/catalog/vod.service.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { currentViewer, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import { ContentKey, EntityId } from './schemas.js';

/** Movies & Series. Opening an Xtream series may call the provider, hence the per-user limit. */
export function createVodRouter(deps: { vod: VodCatalogService; auth: RequestHandler; limit: RateLimiterFactory }): Router {
  const router = Router();
  const detailsLimiter = deps.limit({ name: 'vod:details', windowMs: 60 * 1000, limit: 60, perUser: true });
  router.use(deps.auth);

  router.get('/:sourceId/series/:seriesKey', detailsLimiter, async (req, res) => {
    const sourceId = parseInput(EntityId, routeParam(req, 'sourceId'));
    const seriesKey = parseInput(ContentKey, routeParam(req, 'seriesKey'));
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json(await deps.vod.seriesDetails(currentViewer(req), sourceId, seriesKey));
  });

  return router;
}

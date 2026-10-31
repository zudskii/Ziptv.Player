import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { VodCatalogService } from '../../application/catalog/vod.service.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { currentViewer, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import { ContentKey, EntityId } from './schemas.js';

const ListQuery = z.object({
  category: z.string().max(200).optional(),
  sort: z.enum(['recent', 'name', 'rating', 'year']).default('recent'),
  cursor: z.string().max(12).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

/** Movies & Series per source. Opening an Xtream series may call the provider, hence the limit. */
export function createVodRouter(deps: { vod: VodCatalogService; auth: RequestHandler; limit: RateLimiterFactory }): Router {
  const { vod } = deps;
  const router = Router();
  const detailsLimiter = deps.limit({ name: 'vod:details', windowMs: 60 * 1000, limit: 60, perUser: true });
  router.use(deps.auth);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    next();
  });
  const source = (req: Parameters<RequestHandler>[0]) => parseInput(EntityId, routeParam(req, 'sourceId'));

  router.get('/:sourceId/movies/overview', async (req, res) => {
    res.json(await vod.movieOverview(currentViewer(req), source(req)));
  });
  router.get('/:sourceId/movies', async (req, res) => {
    res.json(await vod.movies(currentViewer(req), source(req), parseInput(ListQuery, req.query)));
  });
  router.get('/:sourceId/movies/:key', async (req, res) => {
    res.json(await vod.movieDetails(currentViewer(req), source(req), parseInput(ContentKey, routeParam(req, 'key'))));
  });

  router.get('/:sourceId/series/overview', async (req, res) => {
    res.json(await vod.seriesOverview(currentViewer(req), source(req)));
  });
  router.get('/:sourceId/series', async (req, res) => {
    res.json(await vod.series(currentViewer(req), source(req), parseInput(ListQuery, req.query)));
  });
  router.get('/:sourceId/series/:seriesKey', detailsLimiter, async (req, res) => {
    res.json(await vod.seriesDetails(currentViewer(req), source(req), parseInput(ContentKey, routeParam(req, 'seriesKey'))));
  });

  return router;
}

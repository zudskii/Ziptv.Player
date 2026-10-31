import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { SearchService } from '../../application/catalog/search.service.js';
import type { HomeService } from '../../application/user-state/home.service.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { currentViewer } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';

const SearchQuery = z.object({ q: z.string().max(200).default('') });

/** GET /home (every rail) and GET /search?q= (channels, movies, series, programmes). */
export function createDiscoverRouter(deps: { home: HomeService; search: SearchService; auth: RequestHandler; limit: RateLimiterFactory }): Router {
  const router = Router();
  const searchLimiter = deps.limit({ name: 'search', windowMs: 60 * 1000, limit: 90, perUser: true });
  // Mounted at the API root: authentication per route, so other paths pass through untouched.
  router.get('/home', deps.auth, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json(await deps.home.home(currentViewer(req)));
  });
  router.get('/search', deps.auth, searchLimiter, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json(await deps.search.search(currentViewer(req), parseInput(SearchQuery, req.query).q));
  });
  return router;
}

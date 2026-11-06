import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { VodBrowseService } from '../../application/catalog/vod-browse.service.js';
import { currentViewer } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';

const list = (max: number, item: z.ZodString) =>
  z
    .string()
    .max(2000)
    .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(item).max(max));

const BrowseQuery = z
  .object({
    sources: list(50, z.string().uuid()).optional(),
    genres: list(30, z.string().max(20)).optional(),
    category: z.string().max(200).optional(),
    yearMin: z.coerce.number().int().min(1880).max(2100).optional(),
    yearMax: z.coerce.number().int().min(1880).max(2100).optional(),
    ratingMin: z.coerce.number().min(0).max(10).optional(),
    length: z.enum(['short', 'medium', 'long']).optional(),
    added: z.coerce.number().int().optional(),
    watch: z.enum(['unwatched', 'started', 'finished']).optional(),
    q: z.string().max(100).optional(),
    sort: z.enum(['recent', 'name', 'rating', 'year']).default('recent'),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(40),
    facets: z
      .enum(['0', '1'])
      .optional()
      .transform((value) => value === '1'),
  })
  .strict();

/** Movies & Series with filters, across the profile's whole library (Phase 15). */
export function createBrowseRouter(deps: { browse: VodBrowseService; auth: RequestHandler }): Router {
  const router = Router();
  router.use(deps.auth);
  router.get('/movies', async (req, res) => {
    res.json(await deps.browse.movies(currentViewer(req), parseInput(BrowseQuery, req.query)));
  });
  router.get('/series', async (req, res) => {
    res.json(await deps.browse.series(currentViewer(req), parseInput(BrowseQuery, req.query)));
  });
  return router;
}

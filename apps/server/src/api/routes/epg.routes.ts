import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { EpgService } from '../../application/epg/epg.service.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { currentUser, currentViewer, queryParam, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import { ContentKey, IsoInstant, EntityId } from './schemas.js';

const HttpUrl = z
  .string()
  .trim()
  .max(4096)
  .refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), 'must be an http(s) URL');

const GuideQuery = z.object({
  sourceId: EntityId,
  from: IsoInstant,
  to: IsoInstant,
  group: z.string().max(200).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const RangeQuery = z.object({ from: IsoInstant.optional(), to: IsoInstant.optional() });
const AddGuideBody = z.object({ url: HttpUrl, name: z.string().trim().min(1).max(100).optional(), sourceIds: z.array(EntityId).max(50).optional() }).strict();
const UpdateGuideBody = z.object({ name: z.string().trim().min(1).max(100).optional(), sourceIds: z.array(EntityId).max(50).optional() }).strict();
const MappingBody = z.object({ sourceId: EntityId, channelKey: ContentKey, guideId: EntityId, epgChannelId: z.string().min(1).max(200) }).strict();

/** EPG API: now/next, schedules, guide grid, search, guide sources and manual mapping. */
export function createEpgRouter(deps: { epg: EpgService; auth: RequestHandler; limit: RateLimiterFactory }): Router {
  const { epg } = deps;
  const router = Router();
  const writeLimiter = deps.limit({ name: 'epg:write', windowMs: 10 * 60 * 1000, limit: 60, perUser: true });
  router.use(deps.auth);
  router.use((_req, res, next) => {
    // Programme data changes every minute; let the browser revalidate instead of caching.
    res.setHeader('Cache-Control', 'private, no-cache');
    next();
  });

  router.get('/now', async (req, res) => {
    const sourceId = parseInput(EntityId, queryParam(req, 'sourceId'), 'sourceId');
    res.json(await epg.nowNext(currentViewer(req), sourceId));
  });

  router.get('/channels/:sourceId/:key', async (req, res) => {
    const range = parseInput(RangeQuery, req.query, 'Range');
    res.json(
      await epg.channelSchedule(currentViewer(req), routeParam(req, 'sourceId'), routeParam(req, 'key'), {
        from: range.from ? new Date(range.from) : undefined,
        to: range.to ? new Date(range.to) : undefined,
      }),
    );
  });

  router.get('/guide', async (req, res) => {
    const query = parseInput(GuideQuery, req.query, 'Guide query');
    res.json(await epg.guide(currentViewer(req), { ...query, from: new Date(query.from), to: new Date(query.to) }));
  });

  router.get('/search', async (req, res) => {
    const q = (queryParam(req, 'q') ?? '').slice(0, 100);
    res.json(await epg.search(currentViewer(req), q));
  });

  router.get('/guides', async (req, res) => {
    res.json(await epg.listGuides(currentUser(req).id));
  });

  router.post('/guides', writeLimiter, async (req, res) => {
    res.status(201).json(await epg.addGuide(currentUser(req).id, parseInput(AddGuideBody, req.body, 'Guide')));
  });

  router.patch('/guides/:guideId', writeLimiter, async (req, res) => {
    res.json(await epg.updateGuide(currentUser(req).id, routeParam(req, 'guideId'), parseInput(UpdateGuideBody, req.body, 'Guide update')));
  });

  router.delete('/guides/:guideId', writeLimiter, async (req, res) => {
    await epg.removeGuide(currentUser(req).id, routeParam(req, 'guideId'));
    res.status(204).end();
  });

  router.post('/guides/:guideId/sync', writeLimiter, async (req, res) => {
    res.status(202).json(await epg.syncGuide(currentUser(req).id, routeParam(req, 'guideId')));
  });

  router.get('/guide-channels', async (req, res) => {
    const sourceId = parseInput(EntityId, queryParam(req, 'sourceId'), 'sourceId');
    res.json(await epg.searchGuideChannels(currentViewer(req), sourceId, (queryParam(req, 'q') ?? '').slice(0, 100)));
  });

  router.get('/links/:sourceId/:key', async (req, res) => {
    res.json(await epg.link(currentViewer(req), routeParam(req, 'sourceId'), routeParam(req, 'key')));
  });

  router.put('/mappings', writeLimiter, async (req, res) => {
    res.json(await epg.setMapping(currentViewer(req), parseInput(MappingBody, req.body, 'Mapping')));
  });

  router.delete('/mappings/:sourceId/:key', writeLimiter, async (req, res) => {
    res.json(await epg.removeMapping(currentViewer(req), routeParam(req, 'sourceId'), routeParam(req, 'key')));
  });

  return router;
}

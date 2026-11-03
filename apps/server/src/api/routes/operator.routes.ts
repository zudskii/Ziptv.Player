import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { OperatorService } from '../../application/operator/operator.service.js';
import { DEVICE_CLASSES } from '../../domain/operator/catalog.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { currentViewer, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import type { ViewingContextResolver } from '../middleware/viewing-context.js';
import { EntityId } from './schemas.js';

export const DeviceClass = z.enum(DEVICE_CLASSES);
const ChannelsQuery = z.object({ lineup: z.string().trim().min(1).max(80).optional(), device: DeviceClass.default('web') }).strict();

/**
 * Operator (licensed) channels. The list is already filtered by rights for the server-determined
 * market and device, so what a viewer sees is exactly what they may play.
 */
export function createOperatorRouter(deps: { operator: OperatorService; auth: RequestHandler; viewingContext: ViewingContextResolver; limit: RateLimiterFactory }): Router {
  const { operator } = deps;
  const router = Router();
  const writeLimiter = deps.limit({ name: 'operator:write', windowMs: 60 * 1000, limit: 60, perUser: true });

  router.get('/channels', deps.auth, async (req, res) => {
    const query = parseInput(ChannelsQuery, req.query, 'Channel filter');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await operator.channels(currentViewer(req), deps.viewingContext(req, query.device), query.lineup));
  });

  router.put('/favorites/:channelId', deps.auth, writeLimiter, async (req, res) => {
    await operator.addFavorite(currentViewer(req), parseInput(EntityId, routeParam(req, 'channelId'), 'Channel id'));
    res.status(204).end();
  });

  router.delete('/favorites/:channelId', deps.auth, writeLimiter, async (req, res) => {
    await operator.removeFavorite(currentViewer(req), parseInput(EntityId, routeParam(req, 'channelId'), 'Channel id'));
    res.status(204).end();
  });

  router.post('/favorites/import-from-my-list', deps.auth, writeLimiter, async (req, res) => {
    res.json(await operator.importFavoritesFromMyList(currentViewer(req), deps.viewingContext(req)));
  });

  return router;
}

import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import { AppError } from '../../application/errors.js';
import type { OperatorEpgService } from '../../application/operator/operator-epg.service.js';
import type { OperatorService } from '../../application/operator/operator.service.js';
import { DEVICE_CLASSES } from '../../domain/operator/catalog.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { currentViewer, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import type { ViewingContextResolver } from '../middleware/viewing-context.js';
import { EntityId } from './schemas.js';

export const DeviceClass = z.enum(DEVICE_CLASSES);
const ChannelsQuery = z.object({ lineup: z.string().trim().min(1).max(80).optional(), device: DeviceClass.default('web') }).strict();
const ScheduleQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), device: DeviceClass.default('web') }).strict();
const GuideQuery = z.object({ channels: z.string().max(40_000).transform((value) => [...new Set(value.split(',').map((id) => id.trim()).filter(Boolean))].slice(0, 1000)), device: DeviceClass.default('web') }).strict();

/**
 * Operator (licensed) channels. The list is already filtered by rights for the server-determined
 * market and device, so what a viewer sees is exactly what they may play.
 */
export function createOperatorRouter(deps: { operator: OperatorService; epg?: OperatorEpgService; auth: RequestHandler; viewingContext: ViewingContextResolver; limit: RateLimiterFactory }): Router {
  const { operator } = deps;
  const router = Router();
  const writeLimiter = deps.limit({ name: 'operator:write', windowMs: 60 * 1000, limit: 60, perUser: true });

  router.get('/channels', deps.auth, async (req, res) => {
    const query = parseInput(ChannelsQuery, req.query, 'Channel filter');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await operator.channels(currentViewer(req), deps.viewingContext(req, query.device), query.lineup));
  });

  // Now / next on operator channels — only for channels in this viewer's list.
  router.get('/guide', deps.auth, async (req, res) => {
    const query = parseInput(GuideQuery, req.query, 'Guide request');
    const visible = new Set((await operator.channels(currentViewer(req), deps.viewingContext(req, query.device))).channels.map((channel) => channel.id));
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json(deps.epg ? await deps.epg.nowNext(query.channels.filter((id) => visible.has(id))) : []);
  });

  // One channel's schedule (past programmes flagged when this viewer may replay them).
  router.get('/channels/:channelId/schedule', deps.auth, async (req, res) => {
    const channelId = parseInput(EntityId, routeParam(req, 'channelId'), 'Channel id');
    const query = parseInput(ScheduleQuery, req.query, 'Schedule request');
    const viewer = currentViewer(req);
    const context = deps.viewingContext(req, query.device);
    const channel = (await operator.channels(viewer, context)).channels.find((item) => item.id === channelId);
    if (!channel || !deps.epg) throw AppError.notFound('Channel');
    const now = Date.now();
    const from = query.from ?? new Date(now - Math.max(channel.catchupDays, 1) * 86_400_000);
    const to = query.to ?? new Date(now + 86_400_000);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json(await deps.epg.schedule(channel.id, { from, to }, channel.catchupDays));
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

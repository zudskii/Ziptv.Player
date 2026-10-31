import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { PlaybackService } from '../../application/playback/playback.service.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { currentViewer } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import { ContentKey, IsoInstant, EntityId } from './schemas.js';

export const ContentRef = z.discriminatedUnion('type', [
  z.object({ type: z.literal('channel'), sourceId: EntityId, key: ContentKey }).strict(),
  z.object({ type: z.literal('movie'), sourceId: EntityId, key: ContentKey }).strict(),
  z.object({ type: z.literal('episode'), sourceId: EntityId, seriesKey: ContentKey, key: ContentKey }).strict(),
  z.object({ type: z.literal('catchup'), sourceId: EntityId, key: ContentKey, start: IsoInstant, end: IsoInstant }).strict(),
]);

const ResolveBody = z
  .object({
    content: ContentRef,
    secureContext: z.boolean(),
    unlockToken: z.string().max(512).optional(),
  })
  .strict();

const EventBody = z
  .object({
    sessionId: z.string().uuid(),
    type: z.enum(['start', 'heartbeat', 'stop', 'error']),
    position: z.number().min(0).max(7 * 86_400).optional(),
    duration: z.number().min(0).max(7 * 86_400).optional(),
    error: z.object({ kind: z.string().max(40), message: z.string().max(500) }).optional(),
    via: z.enum(['direct', 'proxy']).optional(),
    startupMs: z.number().int().min(0).max(600_000).optional(),
  })
  .strict();

/** StartPlayback (plan with candidates) and playback events (progress, history, health). */
export function createPlaybackRouter(deps: { playback: PlaybackService; auth: RequestHandler; withUnlock: RequestHandler; limit: RateLimiterFactory }): Router {
  const router = Router();
  const planLimiter = deps.limit({ name: 'playback:plan', windowMs: 60 * 1000, limit: 120, perUser: true });
  const eventLimiter = deps.limit({ name: 'playback:event', windowMs: 60 * 1000, limit: 240, perUser: true });

  router.post('/', deps.auth, planLimiter, deps.withUnlock, async (req, res) => {
    const body = parseInput(ResolveBody, req.body, 'Playback request');
    res.setHeader('Cache-Control', 'no-store');
    res.json(await deps.playback.resolve(currentViewer(req), body));
  });

  router.post('/events', deps.auth, eventLimiter, async (req, res) => {
    const body = parseInput(EventBody, req.body, 'Playback event');
    await deps.playback.recordEvent(currentViewer(req), body);
    res.status(204).end();
  });

  return router;
}

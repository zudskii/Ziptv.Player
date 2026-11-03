import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { NotificationService } from '../../application/notifications/notification.service.js';
import { currentViewer, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';

const ReadBody = z.object({ ids: z.union([z.literal('all'), z.array(z.string().max(24)).max(200)]) }).strict();

/** In-app notification center. */
export function createNotificationRouter(deps: { notifications: NotificationService; auth: RequestHandler }): Router {
  const router = Router();
  router.use(deps.auth);

  router.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json(await deps.notifications.list(currentViewer(req)));
  });

  router.post('/read', async (req, res) => {
    const body = parseInput(ReadBody, req.body, 'Notification update');
    await deps.notifications.markRead(currentViewer(req), body.ids);
    res.status(204).end();
  });

  // Clears the notifications already read.
  router.delete('/', async (req, res) => {
    res.json({ removed: await deps.notifications.clearRead(currentViewer(req)) });
  });

  router.delete('/:id', async (req, res) => {
    await deps.notifications.remove(currentViewer(req), routeParam(req, 'id'));
    res.status(204).end();
  });

  return router;
}

import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { NotificationService } from '../../application/notifications/notification.service.js';
import { currentUser, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';

const ReadBody = z.object({ ids: z.union([z.literal('all'), z.array(z.string().max(24)).max(200)]) }).strict();

/** In-app notification center. */
export function createNotificationRouter(deps: { notifications: NotificationService; auth: RequestHandler }): Router {
  const router = Router();
  router.use(deps.auth);

  router.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json(await deps.notifications.list(currentUser(req).id));
  });

  router.post('/read', async (req, res) => {
    const body = parseInput(ReadBody, req.body, 'Notification update');
    await deps.notifications.markRead(currentUser(req).id, body.ids);
    res.status(204).end();
  });

  router.delete('/:id', async (req, res) => {
    await deps.notifications.remove(currentUser(req).id, routeParam(req, 'id'));
    res.status(204).end();
  });

  return router;
}

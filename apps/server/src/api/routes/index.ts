import { Router, type RequestHandler } from 'express';

import type { AppConfig } from '../../config/env.js';
import type { Container } from '../../container.js';
import { createAuthRouter } from './auth.routes.js';
import { createLiveRouter } from './live.routes.js';
import { createNotificationRouter } from './notification.routes.js';
import { createPlaybackRouter } from './playback.routes.js';
import { createSessionRouter } from './session.routes.js';
import { createSourceRouter } from './source.routes.js';

/** Every JSON API router under /api/v1. Routes only validate input and call use cases. */
export function createApiRouters(deps: { container: Container; auth: RequestHandler; optionalAuth: RequestHandler; withUnlock: RequestHandler; config: AppConfig }): Router {
  const { container, auth, config } = deps;
  const router = Router();
  router.use('/sessions', createSessionRouter(container.sessions, auth));
  router.use('/auth', createAuthRouter({ accounts: container.accounts, auth, optionalAuth: deps.optionalAuth }));
  router.use('/sources', createSourceRouter({ sources: container.sources, auth, maxSourceBytes: config.limits.maxSourceBytes }));
  router.use('/live', createLiveRouter({ live: container.live, auth }));
  router.use('/playback', createPlaybackRouter({ playback: container.playback, auth, withUnlock: deps.withUnlock }));
  router.use('/notifications', createNotificationRouter({ notifications: container.notifications, auth }));
  return router;
}

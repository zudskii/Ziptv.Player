import { Router, type RequestHandler } from 'express';

import type { AppConfig } from '../../config/env.js';
import type { Container } from '../../container.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { createAuthRouter } from './auth.routes.js';
import { createEpgRouter } from './epg.routes.js';
import { createLiveRouter } from './live.routes.js';
import { createNotificationRouter } from './notification.routes.js';
import { createPlaylistRouter } from './playlist.routes.js';
import { createPlaybackRouter } from './playback.routes.js';
import { createSessionRouter } from './session.routes.js';
import { createSourceRouter } from './source.routes.js';
import { createVodRouter } from './vod.routes.js';

/** Every JSON API router under /api/v1. Routes only validate input and call use cases. */
export function createApiRouters(deps: { container: Container; auth: RequestHandler; optionalAuth: RequestHandler; withUnlock: RequestHandler; config: AppConfig; limit: RateLimiterFactory }): Router {
  const { container, auth, config, limit } = deps;
  const router = Router();
  router.use('/sessions', createSessionRouter(container.sessions, auth, limit));
  router.use('/auth', createAuthRouter({ accounts: container.accounts, emailFlow: container.emailFlow, auth, optionalAuth: deps.optionalAuth, limit }));
  router.use('/sources', createSourceRouter({ sources: container.sources, auth, maxSourceBytes: config.limits.maxSourceBytes, limit }));
  router.use('/live', createLiveRouter({ live: container.live, auth }));
  router.use('/vod', createVodRouter({ vod: container.vod, auth, limit }));
  router.use('/epg', createEpgRouter({ epg: container.epg, auth, limit }));
  router.use('/playback', createPlaybackRouter({ playback: container.playback, auth, withUnlock: deps.withUnlock, limit }));
  router.use('/playlists', createPlaylistRouter({ playlists: container.playlists, entries: container.playlistEntries, auth, publicUrl: config.publicUrl, limit }));
  router.use('/notifications', createNotificationRouter({ notifications: container.notifications, auth }));
  return router;
}

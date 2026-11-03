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
import { createDiscoverRouter } from './discover.routes.js';
import { createMeRouter } from './me.routes.js';
import { createProfileRouter } from './profile.routes.js';
import { createOperatorRouter } from './operator.routes.js';
import { viewingContextResolver } from '../middleware/viewing-context.js';
import { createBillingRouter, createDeviceRouter, createPlaybackSessionRouter } from './billing.routes.js';

/** Every JSON API router under /api/v1. Routes only validate input and call use cases. */
export function createApiRouters(deps: { container: Container; auth: RequestHandler; optionalAuth: RequestHandler; withUnlock: RequestHandler; config: AppConfig; limit: RateLimiterFactory }): Router {
  const { container, auth, config, limit } = deps;
  const router = Router();
  const viewingContext = viewingContextResolver({ header: config.operator.countryHeader, defaultCountry: config.operator.defaultCountry, geo: container.geo });
  router.use('/sessions', createSessionRouter(container.sessions, auth, limit));
  router.use('/auth', createAuthRouter({ accounts: container.accounts, emailFlow: container.emailFlow, auth, optionalAuth: deps.optionalAuth, limit }));
  router.use('/sources', createSourceRouter({ sources: container.sources, auth, maxSourceBytes: config.limits.maxSourceBytes, limit }));
  router.use('/live', createLiveRouter({ live: container.live, auth }));
  router.use('/profiles', createProfileRouter({ profiles: container.profiles, auth, limit }));
  router.use('/me', createMeRouter({ myList: container.myList, watch: container.watch, data: container.viewerData, profiles: container.profiles, auth, limit }));
  router.use('/', createDiscoverRouter({ home: container.home, search: container.search, auth, limit }));
  router.use('/vod', createVodRouter({ vod: container.vod, auth, limit }));
  router.use('/epg', createEpgRouter({ epg: container.epg, auth, limit }));
  router.use('/playback', createPlaybackRouter({ playback: container.playback, auth, withUnlock: deps.withUnlock, viewingContext, limit }));
  router.use('/playlists', createPlaylistRouter({ playlists: container.playlists, entries: container.playlistEntries, auth, publicUrl: config.publicUrl, limit }));
  router.use('/billing', createBillingRouter({ billing: container.commerce.billing, accounts: container.commerce.accounts, auth, publicUrl: config.publicUrl, limit }));
  router.use('/devices', createDeviceRouter({ authorization: container.commerce.authorization, auth, limit }));
  // Before `/operator`: that router answers everything under its prefix.
  router.use('/operator/playback/sessions', createPlaybackSessionRouter({ authorization: container.commerce.authorization, auth, viewingContext, limit }));
  router.use('/operator', createOperatorRouter({ operator: container.operator, auth, viewingContext, limit }));
  router.use('/notifications', createNotificationRouter({ notifications: container.notifications, auth }));
  return router;
}

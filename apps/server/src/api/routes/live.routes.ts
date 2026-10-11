import { Router, type RequestHandler } from 'express';

import type { LiveCatalogService } from '../../application/catalog/live.service.js';
import { currentViewer, routeParam } from '../middleware/request-context.js';

/** Live TV catalog. Channel lists can be MBs: served with a strong validator for 304s. */
export function createLiveRouter(deps: { live: LiveCatalogService; auth: RequestHandler }): Router {
  const { live } = deps;
  const router = Router();
  router.use(deps.auth);

  router.get('/:sourceId/channels', async (req, res) => {
    const viewer = currentViewer(req);
    const sourceId = routeParam(req, 'sourceId');
    const etag = `W/"${sourceId}-${viewer.profileId}-${await live.listVersion(viewer, sourceId)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('Vary', 'Authorization, X-Profile-Id, X-Unlock-Token');
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.json(await live.listChannels(viewer, sourceId));
  });

  router.get('/:sourceId/channels/:key', async (req, res) => {
    res.json(await live.getChannel(currentViewer(req), routeParam(req, 'sourceId'), routeParam(req, 'key')));
  });

  return router;
}

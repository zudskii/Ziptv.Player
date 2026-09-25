import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import { createRateLimiter } from '../../shared/http/rate-limit.js';
import { currentUser } from '../../shared/http/request-context.js';
import { parseInput } from '../../shared/http/validate.js';
import type { PlaybackService } from './playback.service.js';

const ResolveBody = z
  .object({
    playlistId: z.string().regex(/^[a-f0-9]{24}$/i, 'must be a playlist id'),
    channelKey: z.string().regex(/^[a-f0-9]{12}(-\d{1,6})?$/, 'must be a channel key'),
    secureContext: z.boolean(),
  })
  .strict();

/** POST /playback — authenticated: returns the ordered playback candidates for a channel. */
export function createPlaybackRouter(deps: { playback: PlaybackService; auth: RequestHandler }): Router {
  const router = Router();
  const limiter = createRateLimiter({ windowMs: 60 * 1000, limit: 120, perUser: true });

  router.post('/', deps.auth, limiter, async (req, res) => {
    const body = parseInput(ResolveBody, req.body, 'Playback request');
    res.setHeader('Cache-Control', 'no-store');
    res.json(await deps.playback.resolve(currentUser(req).id, body));
  });

  return router;
}

/**
 * Public media routes (stream proxy + logos). No session: `<video>`/`<img>` and hls.js cannot
 * send our Authorization header, so access is granted by the signed token / stored playlist.
 */
export function createMediaRouter(deps: {
  cors: RequestHandler;
  streamProxy: RequestHandler | null;
  logoProxy: RequestHandler;
}): Router {
  const router = Router();
  // Generous: one viewer fetches a segment (and sometimes a playlist) every 2–6 s per rendition.
  const streamLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 1500 });
  const logoLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 600 });

  router.use(deps.cors);
  router.options('/{*any}', (_req, res) => {
    res.status(204).end();
  });

  if (deps.streamProxy) router.get('/stream/:token', streamLimiter, deps.streamProxy);
  router.get('/logos/:playlistId/:channelKey', logoLimiter, deps.logoProxy);

  return router;
}

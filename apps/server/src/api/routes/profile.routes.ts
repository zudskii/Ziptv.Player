import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { ProfileService } from '../../application/identity/profile.service.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { currentUser, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import { EntityId } from './schemas.js';

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be #rrggbb');
const Kind = z.enum(['standard', 'kids']);
const CreateBody = z.object({ name: z.string().max(60), color: Color.optional(), kind: Kind.optional(), pinProtected: z.literal(false).optional() }).strict();
const UpdateBody = z.object({ name: z.string().max(60).optional(), color: Color.optional(), kind: Kind.optional(), pinProtected: z.literal(false).optional() }).strict();
const AccessBody = z.object({ pin: z.string().max(12).optional() }).strict();

/** Profiles of the signed-in account (choosing one = sending its id as `X-Profile-Id`). */
export function createProfileRouter(deps: { profiles: ProfileService; auth: RequestHandler; limit: RateLimiterFactory }): Router {
  const { profiles } = deps;
  const router = Router();
  const writeLimiter = deps.limit({ name: 'profiles:write', windowMs: 10 * 60 * 1000, limit: 60, perUser: true });
  router.use(deps.auth);

  router.get('/', async (req, res) => {
    res.json(await profiles.list(currentUser(req).id));
  });
  router.post('/', writeLimiter, async (req, res) => {
    res.status(201).json(await profiles.create(currentUser(req).id, parseInput(CreateBody, req.body)));
  });
  router.patch('/:profileId', writeLimiter, async (req, res) => {
    res.json(await profiles.update(currentUser(req).id, parseInput(EntityId, routeParam(req, 'profileId')), parseInput(UpdateBody, req.body)));
  });
  router.delete('/:profileId', writeLimiter, async (req, res) => {
    await profiles.remove(currentUser(req).id, parseInput(EntityId, routeParam(req, 'profileId')));
    res.status(204).end();
  });
  router.post('/:profileId/access', writeLimiter, async (req, res) => {
    parseInput(AccessBody, req.body ?? {});
    res.json({ profile: await profiles.access(currentUser(req).id, parseInput(EntityId, routeParam(req, 'profileId'))) });
  });
  return router;
}

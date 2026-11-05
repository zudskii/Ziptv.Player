import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { LibraryService } from '../../application/identity/library.service.js';
import type { ParentalService } from '../../application/identity/parental.service.js';
import type { ProfileService } from '../../application/identity/profile.service.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { currentUser, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import { EntityId } from './schemas.js';

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be #rrggbb');
const Kind = z.enum(['standard', 'kids']);
const Pin = z.string().max(12);
const CreateBody = z.object({ name: z.string().max(60), color: Color.optional(), kind: Kind.optional(), pinProtected: z.boolean().optional(), pin: Pin.optional() }).strict();
const UpdateBody = z.object({ name: z.string().max(60).optional(), color: Color.optional(), kind: Kind.optional(), pinProtected: z.boolean().optional(), pin: Pin.optional() }).strict();
const PinBody = z.object({ pin: Pin.optional() }).strict();
const LibraryBody = z.object({ sourceIds: z.array(z.string().uuid()).max(200), pin: Pin.optional() }).strict();

/**
 * Profiles of the signed-in account (choosing one = `POST /:id/access`, then sending its id as
 * `X-Profile-Id`). Account-level: these routes work before a profile is open (a protected profile,
 * a device held in a kids profile), so they never resolve a viewer.
 */
export function createProfileRouter(deps: { profiles: ProfileService; parental: ParentalService; library: LibraryService; auth: RequestHandler; limit: RateLimiterFactory }): Router {
  const { profiles } = deps;
  const router = Router();
  const writeLimiter = deps.limit({ name: 'profiles:write', windowMs: 10 * 60 * 1000, limit: 60, perUser: true });
  // PIN guessing is also capped by the account lock-out; this keeps one client from hammering it.
  const pinLimiter = deps.limit({ name: 'profiles:pin', windowMs: 10 * 60 * 1000, limit: 30, perUser: true });
  router.use(deps.auth);

  router.get('/', async (req, res) => {
    res.json(await profiles.list(currentUser(req)));
  });
  router.post('/', writeLimiter, async (req, res) => {
    res.status(201).json(await profiles.create(currentUser(req), parseInput(CreateBody, req.body)));
  });
  router.patch('/:profileId', writeLimiter, async (req, res) => {
    res.json(await profiles.update(currentUser(req), parseInput(EntityId, routeParam(req, 'profileId')), parseInput(UpdateBody, req.body)));
  });
  router.delete('/:profileId', writeLimiter, async (req, res) => {
    await profiles.remove(currentUser(req), parseInput(EntityId, routeParam(req, 'profileId')), parseInput(PinBody, req.body ?? {}).pin);
    res.status(204).end();
  });
  // The sources this profile sees (Profile → Library).
  router.get('/:profileId/library', async (req, res) => {
    res.json(await deps.library.profileLibrary(currentUser(req), parseInput(EntityId, routeParam(req, 'profileId'))));
  });
  router.put('/:profileId/library', pinLimiter, async (req, res) => {
    res.json(await deps.library.setProfileLibrary(currentUser(req), parseInput(EntityId, routeParam(req, 'profileId')), parseInput(LibraryBody, req.body)));
  });
  router.post('/:profileId/access', pinLimiter, async (req, res) => {
    const body = parseInput(PinBody, req.body ?? {});
    res.json({ profile: await deps.parental.openProfile(currentUser(req), parseInput(EntityId, routeParam(req, 'profileId')), body.pin) });
  });
  return router;
}

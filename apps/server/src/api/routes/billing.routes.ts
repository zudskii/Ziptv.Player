import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';

import type { AccountBillingService } from '../../application/commerce/account-billing.service.js';
import type { BillingService } from '../../application/commerce/billing.service.js';
import type { PlaybackAuthorizationService } from '../../application/commerce/playback-authorization.service.js';
import { DEVICE_CLASSES } from '../../domain/operator/catalog.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { currentViewer, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import type { ViewingContextResolver } from '../middleware/viewing-context.js';
import { EntityId, IsoInstant } from './schemas.js';

const CheckoutBody = z.object({ packageId: z.string().trim().min(1).max(80) }).strict();
const AccountQuery = z.object({ deviceId: EntityId.optional() });
const DeviceBody = z.object({ key: z.string().min(32).max(128), name: z.string().trim().min(1).max(60), platform: z.enum(DEVICE_CLASSES) }).strict();
const SessionBody = z
  .object({
    channelId: EntityId,
    deviceId: EntityId,
    secureContext: z.boolean(),
    replaces: EntityId.optional(),
    continueSession: z.string().uuid().optional(),
    archive: z.object({ start: IsoInstant, end: IsoInstant }).strict().optional(),
  })
  .strict();

/** Where the processor sends the browser back: the configured public origin, else this request's. */
export function returnBase(req: Request, publicUrl: string | null): string {
  return publicUrl ?? `${req.protocol}://${req.get('host')}`;
}

/** `/billing` — plans, checkout, the viewer's subscription. */
export function createBillingRouter(deps: { billing: BillingService; accounts: AccountBillingService; auth: RequestHandler; publicUrl: string | null; limit: RateLimiterFactory }): Router {
  const router = Router();
  const checkoutLimiter = deps.limit({ name: 'billing:checkout', windowMs: 10 * 60_000, limit: 10, perUser: true });
  // The return page polls every 2 s; each poll of an open checkout asks the processor.
  const statusLimiter = deps.limit({ name: 'billing:checkout-status', windowMs: 60_000, limit: 60, perUser: true });
  router.use(deps.auth);
  router.get('/packages', async (req, res) => {
    res.json(await deps.billing.offers(currentViewer(req)));
  });
  router.post('/checkout', checkoutLimiter, async (req, res) => {
    const body = parseInput(CheckoutBody, req.body, 'Checkout');
    res.status(201).json(await deps.billing.startCheckout(currentViewer(req), body.packageId, returnBase(req, deps.publicUrl)));
  });
  router.get('/checkout/:id', statusLimiter, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await deps.billing.checkoutStatus(currentViewer(req), parseInput(EntityId, routeParam(req, 'id'), 'Checkout id')));
  });
  router.get('/account', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await deps.accounts.summary(currentViewer(req), parseInput(AccountQuery, req.query, 'Account').deviceId ?? null));
  });
  router.post('/subscription/cancel', async (req, res) => {
    res.json(await deps.billing.cancel(currentViewer(req)));
  });
  router.post('/subscription/resume', async (req, res) => {
    res.json(await deps.billing.resume(currentViewer(req)));
  });
  return router;
}

/** `/devices` — the account's registered devices (limited by plan, revocable). */
export function createDeviceRouter(deps: { authorization: PlaybackAuthorizationService; auth: RequestHandler; limit: RateLimiterFactory }): Router {
  const router = Router();
  const writeLimiter = deps.limit({ name: 'devices:write', windowMs: 60 * 60_000, limit: 30, perUser: true });
  router.use(deps.auth);
  router.get('/', async (req, res) => {
    res.json(await deps.authorization.devices(currentViewer(req), null));
  });
  router.post('/', writeLimiter, async (req, res) => {
    res.status(201).json(await deps.authorization.registerDevice(currentViewer(req), parseInput(DeviceBody, req.body, 'Device')));
  });
  router.delete('/:id', writeLimiter, async (req, res) => {
    await deps.authorization.revokeDevice(currentViewer(req), parseInput(EntityId, routeParam(req, 'id'), 'Device id'));
    res.status(204).end();
  });
  return router;
}

/** `/operator/playback/sessions` — authorized viewings of operator channels (Blueprint §8). */
export function createPlaybackSessionRouter(deps: { authorization: PlaybackAuthorizationService; auth: RequestHandler; viewingContext: ViewingContextResolver; limit: RateLimiterFactory }): Router {
  const router = Router();
  const startLimiter = deps.limit({ name: 'playback:sessions', windowMs: 60_000, limit: 60, perUser: true });
  const beatLimiter = deps.limit({ name: 'playback:heartbeat', windowMs: 60_000, limit: 120, perUser: true });
  router.use(deps.auth);
  router.post('/', startLimiter, async (req, res) => {
    const body = parseInput(SessionBody, req.body, 'Playback session');
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(await deps.authorization.start(currentViewer(req), { channelId: body.channelId, deviceId: body.deviceId, secureContext: body.secureContext, ...(body.replaces ? { replaces: body.replaces } : {}), ...(body.continueSession ? { continueSession: body.continueSession } : {}), ...(body.archive ? { archive: body.archive } : {}) }, deps.viewingContext(req)));
  });
  router.post('/:id/heartbeat', beatLimiter, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await deps.authorization.heartbeat(currentViewer(req), parseInput(EntityId, routeParam(req, 'id'), 'Playback session id'), deps.viewingContext(req)));
  });
  router.delete('/:id', async (req, res) => {
    await deps.authorization.stop(currentViewer(req), parseInput(EntityId, routeParam(req, 'id'), 'Playback session id'));
    res.status(204).end();
  });
  return router;
}

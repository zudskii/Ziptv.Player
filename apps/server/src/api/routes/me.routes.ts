import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { ParentalService } from '../../application/identity/parental.service.js';
import type { ProfileService } from '../../application/identity/profile.service.js';
import type { MyListService } from '../../application/user-state/my-list.service.js';
import type { ViewerDataService } from '../../application/user-state/viewer-data.service.js';
import type { WatchStateService } from '../../application/user-state/watch-state.service.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { currentViewer, queryParam, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import { ContentKey, EntityId } from './schemas.js';

const ListType = z.enum(['channel', 'movie', 'series']);
const ProgressType = z.enum(['movie', 'episode']);
const Clearable = z.enum(['history', 'progress', 'my_list', 'cache']);
const HistoryQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
const KeyList = z.record(z.string().max(64), z.array(z.string().max(40)).max(500));
const ImportBody = z.object({ favorites: KeyList, recents: KeyList }).strict();
const LANGUAGE = z.string().max(16);
const SettingsBody = z
  .object({
    general: z.object({ startPage: z.enum(['home', 'live', 'guide', 'movies', 'series']), use24hClock: z.boolean() }).partial().strict().optional(),
    playback: z
      .object({
        autoplay: z.boolean(),
        autoplayNextEpisode: z.boolean(),
        resumePlayback: z.boolean(),
        preferredQuality: z.enum(['auto', 'highest', 'lowest', '1080', '720', '480']),
        preferredAudio: LANGUAGE,
        preferredSubtitles: LANGUAGE,
        hardwareAcceleration: z.boolean(),
      })
      .partial()
      .strict()
      .optional(),
    appearance: z.object({ theme: z.enum(['dark', 'light', 'system']) }).partial().strict().optional(),
    epg: z.object({ timeShiftMinutes: z.number().int(), showProgress: z.boolean() }).partial().strict().optional(),
    data: z.object({ historyRetentionDays: z.number().int() }).partial().strict().optional(),
  })
  .strict();

const PIN = z.string().max(12);
const SetPinBody = z.object({ currentPin: PIN.optional(), pin: PIN }).strict();
const PinOnly = z.object({ pin: PIN }).strict();
const LockSource = z.union([EntityId, z.literal('operator')]);
const RulesBody = z
  .object({
    pin: PIN,
    profileId: EntityId.optional(),
    hideAdult: z.boolean().optional(),
    lockedGroups: z.array(z.object({ sourceId: LockSource, group: z.string().min(1).max(200) }).strict()).max(500).optional(),
    lockedChannels: z.array(z.object({ sourceId: LockSource, key: z.string().min(1).max(200), name: z.string().max(200).optional() }).strict()).max(500).optional(),
  })
  .strict();

/** The active profile's own state: My List, Continue Watching, History, Settings, Data & Storage. */
export function createMeRouter(deps: {
  myList: MyListService;
  watch: WatchStateService;
  data: ViewerDataService;
  profiles: ProfileService;
  parental: ParentalService;
  auth: RequestHandler;
  limit: RateLimiterFactory;
}): Router {
  const router = Router();
  const writeLimiter = deps.limit({ name: 'me:write', windowMs: 60 * 1000, limit: 120, perUser: true });
  router.use(deps.auth);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    next();
  });

  // --- My List --------------------------------------------------------------------------------
  router.get('/list', async (req, res) => {
    res.json(await deps.myList.list(currentViewer(req)));
  });
  const listItem = (req: Parameters<RequestHandler>[0]) => ({
    type: parseInput(ListType, routeParam(req, 'type')),
    sourceId: parseInput(EntityId, routeParam(req, 'sourceId')),
    key: parseInput(ContentKey, routeParam(req, 'key')),
  });
  router.put('/list/:type/:sourceId/:key', writeLimiter, async (req, res) => {
    res.json(await deps.myList.add(currentViewer(req), listItem(req)));
  });
  router.delete('/list/:type/:sourceId/:key', writeLimiter, async (req, res) => {
    await deps.myList.remove(currentViewer(req), listItem(req));
    res.status(204).end();
  });

  // --- Continue Watching ----------------------------------------------------------------------
  router.get('/progress', async (req, res) => {
    res.json(await deps.watch.continueWatching(currentViewer(req), 50));
  });
  router.delete('/progress/:type/:sourceId/:key', writeLimiter, async (req, res) => {
    const seriesKey = queryParam(req, 'seriesKey');
    await deps.watch.removeProgress(currentViewer(req), {
      contentType: parseInput(ProgressType, routeParam(req, 'type')),
      sourceId: parseInput(EntityId, routeParam(req, 'sourceId')),
      key: parseInput(ContentKey, routeParam(req, 'key')),
      seriesKey: seriesKey ? parseInput(ContentKey, seriesKey) : undefined,
    });
    res.status(204).end();
  });

  // --- History --------------------------------------------------------------------------------
  router.get('/history', async (req, res) => {
    res.json(await deps.watch.history(currentViewer(req), parseInput(HistoryQuery, req.query)));
  });
  router.delete('/history', writeLimiter, async (req, res) => {
    await deps.watch.clearHistory(currentViewer(req));
    res.status(204).end();
  });
  router.delete('/history/:id', writeLimiter, async (req, res) => {
    await deps.watch.removeHistory(currentViewer(req), parseInput(z.string().uuid(), routeParam(req, 'id')));
    res.status(204).end();
  });

  // --- Settings, Data & Storage ---------------------------------------------------------------
  router.get('/settings', async (req, res) => {
    res.json(await deps.profiles.settings(currentViewer(req)));
  });
  router.patch('/settings', writeLimiter, async (req, res) => {
    res.json(await deps.profiles.updateSettings(currentViewer(req), parseInput(SettingsBody, req.body)));
  });
  // --- parental controls (PIN per account, rules per profile) --------------------------------------
  const pinLimiter = deps.limit({ name: 'me:pin', windowMs: 10 * 60 * 1000, limit: 30, perUser: true });
  router.get('/parental', async (req, res) => {
    const profileId = req.query.profileId === undefined ? undefined : parseInput(EntityId, req.query.profileId, 'Profile id');
    res.json(await deps.parental.settings(currentViewer(req), profileId));
  });
  router.put('/parental/pin', pinLimiter, async (req, res) => {
    res.json(await deps.parental.setPin(currentViewer(req), parseInput(SetPinBody, req.body)));
  });
  router.delete('/parental/pin', pinLimiter, async (req, res) => {
    res.json(await deps.parental.removePin(currentViewer(req), parseInput(PinOnly, req.body ?? {}).pin));
  });
  router.post('/parental/unlock', pinLimiter, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await deps.parental.unlock(currentViewer(req), parseInput(PinOnly, req.body ?? {}).pin));
  });
  router.put('/parental/rules', pinLimiter, async (req, res) => {
    res.json(await deps.parental.updateRules(currentViewer(req), parseInput(RulesBody, req.body)));
  });

  router.get('/storage', async (req, res) => {
    res.json(await deps.data.usage(currentViewer(req)));
  });
  router.delete('/data/:kind', writeLimiter, async (req, res) => {
    await deps.data.clear(currentViewer(req), parseInput(Clearable, routeParam(req, 'kind')));
    res.status(204).end();
  });
  router.post('/import-local', writeLimiter, async (req, res) => {
    res.json(await deps.data.importLocal(currentViewer(req), parseInput(ImportBody, req.body)));
  });
  return router;
}

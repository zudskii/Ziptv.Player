import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';

import type { PlaylistEntryService } from '../../application/playlists/playlist-entry.service.js';
import type { ExportLink, PlaylistService } from '../../application/playlists/playlist.service.js';
import { PLAYLIST_EXPORT_PREFIX } from '../http-paths.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { currentUser, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import { EntityId } from './schemas.js';

const MAX_NUMBER = 99_999;

const PlaylistName = z.string().trim().min(1, 'is required').max(120);
const EntryName = z.string().trim().min(1, 'is required').max(300);
const EntryIds = z.array(EntityId).min(1).max(5000);
const HttpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

const NameBody = z.object({ name: PlaylistName }).strict();
const ReorderGroupsBody = z.object({ groupIds: z.array(EntityId).max(1000) }).strict();
const DeleteGroupQuery = z.object({ entries: z.enum(['keep', 'delete']).default('keep') });

const ListQuery = z.object({
  groupId: EntityId.optional(),
  ungrouped: z.enum(['true', 'false']).optional(),
  search: z.string().trim().max(100).optional(),
  status: z.literal('missing').optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const AddFromSourceBody = z
  .object({
    sourceId: EntityId,
    select: z.discriminatedUnion('type', [
      z.object({ type: z.literal('all') }).strict(),
      z.object({ type: z.literal('groups'), groups: z.array(z.string().min(1).max(200)).min(1).max(500) }).strict(),
      z.object({ type: z.literal('keys'), keys: z.array(z.string().min(1).max(64)).min(1).max(10_000) }).strict(),
    ]),
    placement: z.discriminatedUnion('type', [
      z.object({ type: z.literal('sourceGroups') }).strict(),
      z.object({ type: z.literal('group'), groupId: EntityId }).strict(),
      z.object({ type: z.literal('ungrouped') }).strict(),
    ]),
  })
  .strict();

const UpdateEntryBody = z
  .object({
    name: EntryName.optional(),
    logo: HttpUrl.nullable().optional(),
    tvgId: z.string().trim().min(1).max(200).nullable().optional(),
    number: z.number().int().min(1).max(MAX_NUMBER).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'nothing to change');

const MoveBody = z.object({ entryIds: EntryIds, groupId: EntityId.nullable(), beforeEntryId: EntityId.nullable().optional() }).strict();
const RemoveBody = z.object({ entryIds: EntryIds }).strict();
const TransferBody = z
  .object({
    entryIds: z.union([z.literal('all'), EntryIds]),
    toPlaylistId: EntityId,
    mode: z.enum(['copy', 'move']),
    group: z.object({ groupId: EntityId.nullable() }).strict().optional(),
  })
  .strict();
const MergeBody = z.object({ sourcePlaylistIds: z.array(EntityId).min(1).max(50) }).strict();
const RenumberBody = z.object({ start: z.number().int().min(1).max(MAX_NUMBER).default(1), step: z.number().int().min(1).max(1000).default(1) }).strict();

export function createPlaylistRouter(deps: {
  playlists: PlaylistService;
  entries: PlaylistEntryService;
  auth: RequestHandler;
  /** Origin for export links; null = the origin of the request. */
  publicUrl: string | null;
  limit: RateLimiterFactory;
}): Router {
  const { playlists, entries, auth, publicUrl } = deps;
  const router = Router();
  router.use(auth);

  // Bulk operations touch thousands of rows: a modest per-user budget keeps one client from hogging the database.
  const bulkLimiter = deps.limit({ name: 'playlists:bulk', windowMs: 60_000, limit: 30, perUser: true });
  const exportLimiter = deps.limit({ name: 'playlists:export', windowMs: 60 * 60_000, limit: 30, perUser: true });

  const linkFor = (req: Request): ExportLink => {
    const base = publicUrl ?? `${req.protocol}://${req.get('host')}`;
    return (token) => `${base}${PLAYLIST_EXPORT_PREFIX}/${token}.m3u`;
  };
  const owner = (req: Request) => currentUser(req).id;
  const id = (req: Request) => parseInput(EntityId, routeParam(req, 'playlistId'), 'Playlist id');

  // --- playlists ----------------------------------------------------------------------------

  router.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json(await playlists.list(owner(req)));
  });

  router.post('/', async (req, res) => {
    const { name } = parseInput(NameBody, req.body, 'Playlist');
    res.status(201).json(await playlists.create(owner(req), name, linkFor(req)));
  });

  router.get('/:playlistId', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store'); // contains the export link
    res.json(await playlists.get(owner(req), id(req), linkFor(req)));
  });

  router.patch('/:playlistId', async (req, res) => {
    const { name } = parseInput(NameBody, req.body, 'Playlist');
    res.json(await playlists.rename(owner(req), id(req), name, linkFor(req)));
  });

  router.delete('/:playlistId', async (req, res) => {
    await playlists.remove(owner(req), id(req));
    res.status(204).end();
  });

  // --- export link --------------------------------------------------------------------------

  /** Turns the link on or replaces it; the previous link stops working immediately. */
  router.post('/:playlistId/export', exportLimiter, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ enabled: true, url: await playlists.enableExport(owner(req), id(req), linkFor(req)) });
  });

  router.delete('/:playlistId/export', async (req, res) => {
    await playlists.disableExport(owner(req), id(req));
    res.status(204).end();
  });

  // --- groups -------------------------------------------------------------------------------

  router.post('/:playlistId/groups', async (req, res) => {
    const { name } = parseInput(NameBody, req.body, 'Group');
    res.status(201).json(await playlists.createGroup(owner(req), id(req), name));
  });

  router.put('/:playlistId/groups/order', async (req, res) => {
    const { groupIds } = parseInput(ReorderGroupsBody, req.body, 'Group order');
    await playlists.reorderGroups(owner(req), id(req), groupIds);
    res.status(204).end();
  });

  router.patch('/:playlistId/groups/:groupId', async (req, res) => {
    const { name } = parseInput(NameBody, req.body, 'Group');
    await playlists.renameGroup(owner(req), id(req), parseInput(EntityId, routeParam(req, 'groupId'), 'Group id'), name);
    res.status(204).end();
  });

  router.delete('/:playlistId/groups/:groupId', async (req, res) => {
    const { entries: what } = parseInput(DeleteGroupQuery, req.query, 'Query');
    await playlists.deleteGroup(owner(req), id(req), parseInput(EntityId, routeParam(req, 'groupId'), 'Group id'), what === 'delete');
    res.status(204).end();
  });

  // --- entries ------------------------------------------------------------------------------

  router.get('/:playlistId/entries', async (req, res) => {
    const query = parseInput(ListQuery, req.query, 'Query');
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json(
      await entries.list(owner(req), id(req), {
        groupId: query.groupId,
        ungrouped: query.ungrouped === 'true',
        search: query.search,
        missingOnly: query.status === 'missing',
        offset: query.offset,
        limit: query.limit,
      }),
    );
  });

  router.post('/:playlistId/entries/from-source', bulkLimiter, async (req, res) => {
    res.json(await entries.addFromSource(owner(req), id(req), parseInput(AddFromSourceBody, req.body, 'Request')));
  });

  router.post('/:playlistId/entries/move', bulkLimiter, async (req, res) => {
    res.json(await entries.move(owner(req), id(req), parseInput(MoveBody, req.body, 'Move')));
  });

  router.post('/:playlistId/entries/transfer', bulkLimiter, async (req, res) => {
    res.json(await entries.transfer(owner(req), id(req), parseInput(TransferBody, req.body, 'Transfer')));
  });

  router.delete('/:playlistId/entries', bulkLimiter, async (req, res) => {
    res.json(await entries.remove(owner(req), id(req), parseInput(RemoveBody, req.body, 'Request').entryIds));
  });

  router.patch('/:playlistId/entries/:entryId', async (req, res) => {
    res.json(await entries.update(owner(req), id(req), parseInput(EntityId, routeParam(req, 'entryId'), 'Entry id'), parseInput(UpdateEntryBody, req.body, 'Entry')));
  });

  // --- whole-playlist operations ------------------------------------------------------------

  router.post('/:playlistId/merge', bulkLimiter, async (req, res) => {
    res.json(await entries.merge(owner(req), id(req), parseInput(MergeBody, req.body, 'Merge').sourcePlaylistIds));
  });

  router.post('/:playlistId/renumber', bulkLimiter, async (req, res) => {
    const { start, step } = parseInput(RenumberBody, req.body ?? {}, 'Numbering');
    res.json(await entries.renumber(owner(req), id(req), { start, step }));
  });

  router.post('/:playlistId/relink', bulkLimiter, async (req, res) => {
    res.json(await entries.relink(owner(req), id(req)));
  });

  return router;
}

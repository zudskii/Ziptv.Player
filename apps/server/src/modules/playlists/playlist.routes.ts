import path from 'node:path';

import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { AppError } from '../../shared/errors.js';
import { createRateLimiter } from '../../shared/http/rate-limit.js';
import { currentUser, routeParam } from '../../shared/http/request-context.js';
import { parseInput } from '../../shared/http/validate.js';
import type { PlaylistService } from './playlist.service.js';

const Name = z.string().trim().min(1, 'must not be empty').max(80, 'must be at most 80 characters');

const UploadBody = z.object({ name: Name.optional() });

const ImportBody = z
  .object({
    url: z
      .string()
      .trim()
      .max(4096)
      .refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), 'must be an http(s) URL'),
    name: Name.optional(),
  })
  .strict();

const RenameBody = z.object({ name: Name }).strict();

export function createPlaylistRouter(deps: {
  playlists: PlaylistService;
  auth: RequestHandler;
  maxPlaylistBytes: number;
}): Router {
  const { playlists, auth } = deps;
  const router = Router();

  // Memory storage: the upload is parsed and stored in the database — nothing touches the
  // local disk (ephemeral on PaaS) and there is no user-controlled file path anymore.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.maxPlaylistBytes, files: 1, fields: 4, fieldSize: 1024 },
  });
  const importLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, limit: 30, perUser: true });

  router.use(auth);

  router.get('/', async (req, res) => {
    res.json(await playlists.list(currentUser(req).id));
  });

  router.post('/upload', importLimiter, upload.single('file'), async (req, res) => {
    if (!req.file) throw AppError.validation('Attach the playlist as multipart field "file".');
    const body = parseInput(UploadBody, req.body ?? {}, 'Upload');
    const created = await playlists.createFromUpload(currentUser(req).id, {
      fileName: sanitizeFileName(req.file.originalname),
      bytes: req.file.buffer,
      name: body.name,
    });
    res.status(201).json(created);
  });

  router.post('/import', importLimiter, async (req, res) => {
    const body = parseInput(ImportBody, req.body, 'Import');
    const created = await playlists.createFromUrl(currentUser(req).id, { url: new URL(body.url), name: body.name });
    res.status(201).json(created);
  });

  router.get('/:playlistId', async (req, res) => {
    res.json(await playlists.get(currentUser(req).id, routeParam(req, 'playlistId')));
  });

  router.patch('/:playlistId', async (req, res) => {
    const body = parseInput(RenameBody, req.body, 'Rename');
    res.json(await playlists.rename(currentUser(req).id, routeParam(req, 'playlistId'), body.name));
  });

  router.delete('/:playlistId', async (req, res) => {
    await playlists.remove(currentUser(req).id, routeParam(req, 'playlistId'));
    res.status(204).end();
  });

  router.post('/:playlistId/refresh', importLimiter, async (req, res) => {
    res.json(await playlists.refresh(currentUser(req).id, routeParam(req, 'playlistId')));
  });

  router.get('/:playlistId/channels', async (req, res) => {
    const userId = currentUser(req).id;
    const playlistId = routeParam(req, 'playlistId');

    // Channel lists can be MBs; the revision is a perfect validator for conditional GETs.
    const revision = await playlists.currentRevision(userId, playlistId);
    const etag = `W/"${playlistId}-${revision}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.json(await playlists.listChannels(userId, playlistId));
  });

  return router;
}

function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: this regex exists to strip control characters
  const base = path.basename(name || 'playlist.m3u').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'playlist.m3u').slice(0, 200);
}

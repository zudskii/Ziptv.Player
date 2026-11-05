import path from 'node:path';

import { Router, type Request, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { AppError } from '../../application/errors.js';
import type { SourceService } from '../../application/sources/source.service.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import type { NewSourceAudience, SourceDto } from '@ziptv/contracts';

import type { LibraryService } from '../../application/identity/library.service.js';
import { seesSource } from '../../application/identity/viewer.js';
import { currentUser, currentViewer, routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';

const Name = z.string().trim().min(1, 'must not be empty').max(80, 'must be at most 80 characters');

const HttpUrl = z
  .string()
  .trim()
  .max(4096)
  .refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), 'must be an http(s) URL');

const XtreamCredentials = z
  .object({
    server: HttpUrl,
    username: z.string().trim().min(1, 'is required').max(200),
    password: z.string().min(1, 'is required').max(200),
  })
  .strict();

const Audience = z.enum(['profile', 'all']);

const AddSourceBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('m3u_url'), url: HttpUrl, name: Name.optional(), audience: Audience.optional() }).strict(),
  XtreamCredentials.extend({ type: z.literal('xtream'), name: Name.optional(), audience: Audience.optional() }).strict(),
]);

const UploadBody = z.object({ name: Name.optional(), audience: Audience.optional() });

const SourceProfilesBody = z.object({ profileIds: z.array(z.string().uuid()).max(50), pin: z.string().max(12).optional() }).strict();
const ListQuery = z.object({ scope: z.enum(['profile', 'account']).optional() });

const UpdateSourceBody = z
  .object({
    name: Name.optional(),
    autoSync: z.boolean().optional(),
    intervalHours: z.number().int().min(1).max(168).optional(),
    url: HttpUrl.optional(),
    xtream: XtreamCredentials.optional(),
  })
  .strict();

/** Settings → Sources. */
export function createSourceRouter(deps: { sources: SourceService; library: LibraryService; auth: RequestHandler; maxSourceBytes: number; limit: RateLimiterFactory }): Router {
  const { sources, library, auth } = deps;
  /** A new source goes into the adding profile's library (or every grown-up profile's). */
  const assign = async (req: Request, created: SourceDto, audience: NewSourceAudience | undefined): Promise<SourceDto> => {
    await library.assignNewSource(currentViewer(req), created.id, audience ?? 'profile');
    return sources.get(currentUser(req).id, created.id);
  };
  /**
   * Profiles see their library; Settings → Sources manages the whole account (`?scope=account`).
   * Kids profiles never see sources outside their library.
   */
  const scoped = (req: Request, scope: 'profile' | 'account' | undefined) => (scope === 'account' && !currentViewer(req).kids ? undefined : currentViewer(req));
  const router = Router();

  // Memory storage: the upload is parsed and stored in the database — nothing touches the
  // local disk (ephemeral on PaaS) and there is no user-controlled file path.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.maxSourceBytes, files: 1, fields: 4, fieldSize: 1024 },
  });
  const writeLimiter = deps.limit({ name: 'sources:write', windowMs: 10 * 60 * 1000, limit: 30, perUser: true });

  router.use(auth);

  router.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json(await sources.list(currentUser(req).id, scoped(req, parseInput(ListQuery, req.query).scope)));
  });

  router.post('/', writeLimiter, async (req, res) => {
    const body = parseInput(AddSourceBody, req.body, 'Source');
    const ownerId = currentUser(req).id;
    const created =
      body.type === 'm3u_url'
        ? await sources.addUrl(ownerId, { url: new URL(body.url), name: body.name })
        : await sources.addXtream(ownerId, { server: new URL(body.server), username: body.username, password: body.password, name: body.name });
    // Accepted: the first sync runs in the background; poll GET /sources/:id for progress.
    res.status(202).json(await assign(req, created, body.audience));
  });

  router.post('/upload', writeLimiter, upload.single('file'), async (req, res) => {
    if (!req.file) throw AppError.validation('Attach the playlist as multipart field "file".');
    const body = parseInput(UploadBody, req.body ?? {}, 'Upload');
    const created = await sources.addFile(currentUser(req).id, {
      fileName: sanitizeFileName(req.file.originalname),
      bytes: req.file.buffer,
      name: body.name,
    });
    res.status(201).json(await assign(req, created, body.audience));
  });

  router.get('/:sourceId', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    const viewer = currentViewer(req);
    const sourceId = routeParam(req, 'sourceId');
    if (viewer.kids && !seesSource(viewer, sourceId)) throw AppError.notFound('Source');
    res.json(await sources.get(currentUser(req).id, sourceId));
  });

  router.get('/:sourceId/profiles', async (req, res) => {
    if (currentViewer(req).kids) throw AppError.forbidden('Kids profiles cannot see other profiles.');
    res.json(await library.sourceProfiles(currentUser(req), routeParam(req, 'sourceId')));
  });

  router.put('/:sourceId/profiles', writeLimiter, async (req, res) => {
    res.json(await library.setSourceProfiles(currentUser(req), routeParam(req, 'sourceId'), parseInput(SourceProfilesBody, req.body)));
  });

  router.patch('/:sourceId', async (req, res) => {
    const body = parseInput(UpdateSourceBody, req.body, 'Source update');
    res.json(await sources.update(currentUser(req).id, routeParam(req, 'sourceId'), body));
  });

  router.delete('/:sourceId', async (req, res) => {
    await sources.remove(currentUser(req).id, routeParam(req, 'sourceId'));
    res.status(204).end();
  });

  router.post('/:sourceId/sync', writeLimiter, async (req, res) => {
    res.status(202).json(await sources.syncNow(currentUser(req).id, routeParam(req, 'sourceId')));
  });

  router.post('/:sourceId/convert-to-xtream', writeLimiter, async (req, res) => {
    res.status(202).json(await sources.convertToXtream(currentUser(req).id, routeParam(req, 'sourceId')));
  });

  router.post('/:sourceId/file', writeLimiter, upload.single('file'), async (req, res) => {
    if (!req.file) throw AppError.validation('Attach the playlist as multipart field "file".');
    res.json(
      await sources.replaceFile(currentUser(req).id, routeParam(req, 'sourceId'), {
        fileName: sanitizeFileName(req.file.originalname),
        bytes: req.file.buffer,
      }),
    );
  });

  return router;
}

function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: this regex exists to strip control characters
  const base = path.basename(name || 'playlist.m3u').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'playlist.m3u').slice(0, 200);
}

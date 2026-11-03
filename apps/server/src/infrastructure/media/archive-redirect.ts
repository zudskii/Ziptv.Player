import type { RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';
import type { MediaGrant, MediaUrls } from '../../application/ports/media-urls.js';
import { buildCatchupUrl, catchupProblem, CatchupTemplateError } from '../../domain/catalog/catchup-url.js';
import type { MediaTokenCodec } from '../crypto/media-token.js';

const UNIX_SECONDS = /^\d{9,11}$/;

/**
 * GET /archive/:token?utc=&utcend= — catch-up of an exported (proxied) channel. The player fills
 * in the programme times from the `catchup-source` template; the server checks the export link is
 * still active and the programme is inside the channel's archive window, builds the provider's
 * archive URL and redirects into the stream proxy (same grant). The provider address stays inside
 * encrypted tokens.
 */
export function createArchiveRedirectHandler(deps: { tokens: MediaTokenCodec; media: MediaUrls; grants: { isActive(grant: MediaGrant): Promise<boolean> } }): RequestHandler {
  return async (req, res) => {
    const token = deps.tokens.verify(String(req.params.token ?? ''), 'archive');
    if (!token?.grant || !token.catchup) throw new AppError('FORBIDDEN', 403, 'Archive link is invalid or expired.');
    if (!(await deps.grants.isActive(token.grant))) throw new AppError('FORBIDDEN', 403, 'Archive link was revoked.');

    const utc = String(req.query.utc ?? '');
    const utcEnd = String(req.query.utcend ?? '');
    if (!UNIX_SECONDS.test(utc) || !UNIX_SECONDS.test(utcEnd)) throw AppError.validation('utc and utcend must be Unix times (seconds).');
    const range = { start: new Date(Number(utc) * 1000), end: new Date(Number(utcEnd) * 1000) };
    const now = new Date(deps.tokens.now() * 1000);
    const problem = catchupProblem(token.catchup.days, range, now);
    if (problem) throw new AppError('UNPLAYABLE', 422, 'This programme is not available from the archive.', { reason: 'catchup_unavailable', problem });

    let archiveUrl: string | null;
    try {
      archiveUrl = buildCatchupUrl(token.catchup, token.url, { ...range, now });
    } catch (error) {
      if (error instanceof CatchupTemplateError) throw new AppError('UNPLAYABLE', 422, 'This archive cannot be played.', { reason: 'unsupported_format' });
      throw error;
    }
    if (!archiveUrl) throw new AppError('UNPLAYABLE', 422, 'This archive cannot be played.', { reason: 'unsupported_format' });

    res.setHeader('Cache-Control', 'no-store');
    // Relative: resolves next to /archive/… under whatever origin and prefix the player used.
    const target = deps.media.streamProxyPath(archiveUrl, token.headers ?? {}, token.expiresAt, token.grant);
    res.redirect(302, `../${target.split('/').slice(-2).join('/')}`);
  };
}

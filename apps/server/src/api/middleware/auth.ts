import type { RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';
import type { SessionService } from '../../application/identity/session.service.js';
import type { ViewerResolver } from '../../application/identity/viewer-resolver.js';

/**
 * `Authorization: Bearer <token>` → `req.user`, then `X-Profile-Id` / `X-Unlock-Token` →
 * `req.viewer` (active profile and its parental restrictions).
 */
export function requireSession(sessions: SessionService, viewers: ViewerResolver): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token) throw AppError.unauthorized();

    const user = await sessions.authenticate(token);
    if (!user) throw AppError.unauthorized('Session is unknown or expired. Create a new session.');
    req.user = user;
    req.viewer = await viewers.resolve(user, {
      profileId: headerValue(req.headers['x-profile-id']),
      unlockToken: headerValue(req.headers['x-unlock-token']),
    });
    next();
  };
}

/**
 * Like `requireSession`, but a missing or invalid token is not an error: `req.user` is just
 * left unset. For endpoints that behave differently for a signed-in guest (register, login).
 */
export function optionalSession(sessions: SessionService): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (token) {
      const user = await sessions.authenticate(token);
      if (user) req.user = user;
    }
    next();
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || undefined;
}

/** Playback requests may carry the unlock token in the JSON body (`unlockToken`). */
export function acceptBodyUnlock(viewers: ViewerResolver): RequestHandler {
  return async (req, _res, next) => {
    const token = typeof req.body?.unlockToken === 'string' ? (req.body.unlockToken as string) : undefined;
    if (token && req.user && req.viewer && !req.viewer.unlocked) {
      req.viewer = await viewers.resolve(req.user, { profileId: req.viewer.profileId, unlockToken: token });
    }
    next();
  };
}

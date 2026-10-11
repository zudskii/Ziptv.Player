import type { Request } from 'express';

import { AppError } from '../../application/errors.js';
import type { AuthUser } from '../../application/identity/session.service.js';
import type { Viewer } from '../../application/identity/viewer.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `requireSession`. */
    user?: AuthUser;
    /** Set by `requireSession`: account + active profile + parental restrictions. */
    viewer?: Viewer;
  }
}

/** The authenticated user; only call behind `requireSession`. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
}

/** The active profile with its restrictions; only call behind `requireSession`. */
export function currentViewer(req: Request): Viewer {
  if (!req.viewer) throw AppError.unauthorized();
  return req.viewer;
}

/** Route parameter as a plain string (Express 5 types allow `string[]` for wildcards). */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw AppError.validation(`Missing route parameter "${name}".`);
  return value;
}

/** Single-valued query string parameter. */
export function queryParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === 'string' ? value : undefined;
}

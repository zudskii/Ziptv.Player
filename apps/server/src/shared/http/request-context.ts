import type { Request } from 'express';

import { AppError } from '../errors.js';

export interface AuthUser {
  id: string;
  createdAt: Date;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `requireSession`. */
    user?: AuthUser;
  }
}

/** The authenticated user; only call behind `requireSession`. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
}

/** Route parameter as a plain string (Express 5 types allow `string[]` for wildcards). */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw AppError.validation(`Missing route parameter "${name}".`);
  return value;
}

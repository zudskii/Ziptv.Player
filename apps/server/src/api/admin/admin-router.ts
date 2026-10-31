import { Router, type Request, type RequestHandler } from 'express';

import type { AdminContext, StaffPrincipal } from '../../application/admin/principal.js';
import { AppError } from '../../application/errors.js';
import type { Permission } from '../../domain/admin/rbac.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by the admin router for every non-public route. */
    staff?: StaffPrincipal;
  }
}

/**
 * Who may call an admin route:
 *   public     — sign-in steps only;
 *   session    — any signed-in staff member, even before a temporary password was replaced
 *                (me, change password, sign out);
 *   Permission — signed in, password replaced, and the role grants the permission.
 */
export type AdminAccess = 'public' | 'session' | Permission;

export interface AdminRouteInfo {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  access: AdminAccess;
}

export interface StaffAuthenticator {
  authenticate(token: string): Promise<StaffPrincipal | null>;
}

/**
 * Every admin route is declared with its access level — there is no way to register one without
 * it, and the list is inspectable (a test walks it and proves each guard). Deny by default:
 * anything not declared answers 404 behind the router.
 */
export class AdminRouter {
  readonly router = Router();
  readonly routes: AdminRouteInfo[] = [];

  constructor(private readonly auth: StaffAuthenticator) {}

  get(path: string, access: AdminAccess, ...handlers: RequestHandler[]): this {
    return this.add('get', path, access, handlers);
  }

  post(path: string, access: AdminAccess, ...handlers: RequestHandler[]): this {
    return this.add('post', path, access, handlers);
  }

  patch(path: string, access: AdminAccess, ...handlers: RequestHandler[]): this {
    return this.add('patch', path, access, handlers);
  }

  delete(path: string, access: AdminAccess, ...handlers: RequestHandler[]): this {
    return this.add('delete', path, access, handlers);
  }

  private add(method: AdminRouteInfo['method'], path: string, access: AdminAccess, handlers: RequestHandler[]): this {
    this.routes.push({ method, path, access });
    const guards: RequestHandler[] = access === 'public' ? [] : [this.requireStaff(), gate(access)];
    this.router[method](path, ...guards, ...handlers);
    return this;
  }

  private requireStaff(): RequestHandler {
    return async (req, _res, next) => {
      const header = req.headers.authorization;
      const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const staff = token ? await this.auth.authenticate(token) : null;
      if (!staff) throw AppError.unauthorized('Sign in to the console.');
      req.staff = staff;
      next();
    };
  }
}

function gate(access: Exclude<AdminAccess, 'public'>): RequestHandler {
  return (req, _res, next) => {
    const staff = currentStaff(req);
    if (access === 'session') return next();
    if (staff.mustChangePassword) throw new AppError('PASSWORD_CHANGE_REQUIRED', 403, 'Replace your temporary password first.');
    if (!staff.permissions.has(access)) throw AppError.forbidden(`Your role (${staff.role}) does not allow this.`);
    next();
  };
}

export function currentStaff(req: Request): StaffPrincipal {
  if (!req.staff) throw AppError.unauthorized('Sign in to the console.');
  return req.staff;
}

export function adminContext(req: Request): AdminContext {
  const ua = req.headers['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 200) : null };
}

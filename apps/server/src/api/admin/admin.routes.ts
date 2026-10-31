import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { AdminUsersService } from '../../application/admin/admin-users.service.js';
import type { AuditService } from '../../application/admin/audit.service.js';
import { toMeDto } from '../../application/admin/principal.js';
import type { StaffAuthService } from '../../application/admin/staff-auth.service.js';
import type { StaffService } from '../../application/admin/staff.service.js';
import type { SystemOverviewService } from '../../application/admin/system.service.js';
import { STAFF_ROLES } from '../../domain/admin/rbac.js';
import type { RateLimiterFactory } from '../middleware/rate-limit.js';
import { routeParam } from '../middleware/request-context.js';
import { parseInput } from '../middleware/validate.js';
import { EntityId } from '../routes/schemas.js';
import { adminContext, AdminRouter, currentStaff } from './admin-router.js';

export interface AdminServices {
  auth: StaffAuthService;
  staff: StaffService;
  audit: AuditService;
  users: AdminUsersService;
  system: SystemOverviewService;
}

const Email = z.string().trim().email().max(254);
const Role = z.enum(STAFF_ROLES);
const LoginBody = z.object({ email: Email, password: z.string().min(1).max(256) }).strict();
const MfaBody = z.object({ challenge: z.string().min(10).max(2048), code: z.string().trim().regex(/^\d{6}$/, 'must be 6 digits') }).strict();
const PasswordBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) }).strict();
const CreateStaffBody = z.object({ email: Email, name: z.string().trim().min(1).max(100), role: Role }).strict();
const UpdateStaffBody = z
  .object({ name: z.string().trim().min(1).max(100).optional(), role: Role.optional(), disabled: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'nothing to change');
const AuditQuery = z.object({
  actorId: EntityId.optional(),
  action: z.string().max(80).optional(),
  targetType: z.string().max(40).optional(),
  targetId: z.string().max(80).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const UsersQuery = z.object({ q: z.string().max(200).optional(), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(25) });

const digest = (value: string) => createHash('sha256').update(value).digest('base64url').slice(0, 22);

/** `/admin/v1` — every route declares its access; see AdminRouter. */
export function createAdminRoutes(services: AdminServices, limit: RateLimiterFactory): AdminRouter {
  const r = new AdminRouter(services.auth);
  const loginIp = limit({ name: 'admin:login-ip', windowMs: 10 * 60_000, limit: 10, skipSuccessful: true });
  // Successful password steps count too: a known password must not mint unlimited MFA challenges.
  const loginEmail = limit({ name: 'admin:login-email', windowMs: 15 * 60_000, limit: 10, key: (req) => (typeof req.body?.email === 'string' ? `email:${digest(req.body.email.trim().toLowerCase())}` : undefined) });
  const mfa = limit({ name: 'admin:mfa', windowMs: 5 * 60_000, limit: 5, skipSuccessful: true, key: (req) => (typeof req.body?.challenge === 'string' ? `challenge:${digest(req.body.challenge)}` : undefined) });
  const mfaIp = limit({ name: 'admin:mfa-ip', windowMs: 10 * 60_000, limit: 20, skipSuccessful: true });

  // --- sign-in -------------------------------------------------------------------------------
  r.post('/auth/login', 'public', loginIp, loginEmail, async (req, res) => {
    res.json(await services.auth.login(parseInput(LoginBody, req.body, 'Sign-in'), adminContext(req)));
  });
  r.post('/auth/mfa', 'public', mfaIp, mfa, async (req, res) => {
    res.json(await services.auth.verifyMfa(parseInput(MfaBody, req.body, 'Code'), adminContext(req)));
  });
  r.get('/me', 'session', (req, res) => {
    res.json(toMeDto(currentStaff(req)));
  });
  r.post('/auth/logout', 'session', async (req, res) => {
    await services.auth.logout(currentStaff(req), adminContext(req));
    res.status(204).end();
  });
  r.post('/auth/password', 'session', async (req, res) => {
    await services.auth.changePassword(currentStaff(req), parseInput(PasswordBody, req.body, 'Password change'), adminContext(req));
    res.status(204).end();
  });

  // --- overview ------------------------------------------------------------------------------
  r.get('/system/overview', 'system:read', async (_req, res) => {
    res.json(await services.system.overview());
  });

  // --- staff -----------------------------------------------------------------------------------
  r.get('/staff', 'staff:read', async (_req, res) => {
    res.json(await services.staff.list());
  });
  r.post('/staff', 'staff:write', async (req, res) => {
    res.status(201).json(await services.staff.create(currentStaff(req), parseInput(CreateStaffBody, req.body, 'Staff member'), adminContext(req)));
  });
  r.patch('/staff/:id', 'staff:write', async (req, res) => {
    const id = parseInput(EntityId, routeParam(req, 'id'), 'Staff id');
    res.json(await services.staff.update(currentStaff(req), id, parseInput(UpdateStaffBody, req.body, 'Staff change'), adminContext(req)));
  });
  r.post('/staff/:id/reset-mfa', 'staff:write', async (req, res) => {
    res.json(await services.staff.resetMfa(currentStaff(req), parseInput(EntityId, routeParam(req, 'id'), 'Staff id'), adminContext(req)));
  });
  r.post('/staff/:id/reset-password', 'staff:write', async (req, res) => {
    res.json(await services.staff.resetPassword(currentStaff(req), parseInput(EntityId, routeParam(req, 'id'), 'Staff id'), adminContext(req)));
  });

  // --- audit -----------------------------------------------------------------------------------
  r.get('/audit', 'audit:read', async (req, res) => {
    res.json(await services.audit.list(parseInput(AuditQuery, req.query, 'Audit filter')));
  });
  r.get('/audit/verify', 'audit:read', async (_req, res) => {
    res.json(await services.audit.verify());
  });

  // --- subscribers -------------------------------------------------------------------------------
  r.get('/users', 'users:read', async (req, res) => {
    const query = parseInput(UsersQuery, req.query, 'User search');
    res.json(await services.users.search({ text: query.q, offset: query.offset, limit: query.limit }));
  });
  r.get('/users/:id', 'users:read', async (req, res) => {
    res.json(await services.users.get(parseInput(EntityId, routeParam(req, 'id'), 'User id')));
  });
  r.post('/users/:id/revoke-sessions', 'users:write', async (req, res) => {
    res.json(await services.users.revokeSessions(currentStaff(req), parseInput(EntityId, routeParam(req, 'id'), 'User id'), adminContext(req)));
  });

  return r;
}

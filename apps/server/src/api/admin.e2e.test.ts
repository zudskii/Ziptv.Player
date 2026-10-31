import type {
  AdminLoginResponse,
  AdminSessionDto,
  AdminUserDetailDto,
  AdminUserPageDto,
  AuditPageDto,
  AuditVerificationDto,
  CreatedStaffDto,
  SessionDto,
  StaffDto,
  SystemOverviewDto,
} from '@ziptv/contracts';
import type { Express } from 'express';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { totpCode, totpStep } from '../domain/admin/totp.js';
import { newEntityId } from '../domain/shared/ids.js';
import { ScryptPasswordHasher } from '../infrastructure/crypto/password-hasher.js';
import { createLogger } from '../infrastructure/logger.js';
import { PgAdminUnitOfWork } from '../infrastructure/persistence/postgres/repositories/admin.repository.js';
import { startTestApp, TEST_DATABASE_URL, waitFor, type TestApp } from '../test/harness.js';
import { createAdminApp } from './admin/admin-app.js';
import type { AdminRouteInfo } from './admin/admin-router.js';

/**
 * Operator console end to end: password + TOTP sign-in, forced password change, permission
 * checks on every declared route, audited staff/support actions, tamper-evident audit trail,
 * and isolation from the public listener.
 */
describe.skipIf(!TEST_DATABASE_URL)('Operator console', () => {
  let t: TestApp;
  let admin: Express & { adminRoutes: AdminRouteInfo[] };
  const PASSWORD = 'initial-password-123';

  beforeAll(async () => {
    t = await startTestApp({ JOBS_ENABLED: 'true' });
    t.container.jobs.start();
    admin = createAdminApp({ config: t.config, logger: createLogger({ log: { level: 'silent' }, env: 'test' }), container: t.container }) as Express & { adminRoutes: AdminRouteInfo[] };
  });
  afterAll(async () => t?.close());

  /** Bootstraps a staff member the way the CLI does (no console actor yet). */
  async function bootstrap(email: string, role: StaffDto['role']): Promise<void> {
    const hash = await new ScryptPasswordHasher({ N: 2 ** 10, r: 8, p: 1 }, 4).hash(PASSWORD);
    await new PgAdminUnitOfWork(t.db).run(async (tx) => {
      const staff = await tx.staff.create({ id: newEntityId(), email, name: email, role, passwordHash: hash, now: new Date() });
      await tx.audit.append({ occurredAt: new Date(), actorId: null, actorEmail: 'cli', action: 'staff.created', targetType: 'staff', targetId: staff.id, beforeHash: null, afterHash: null, details: { role }, ip: null });
    });
  }

  /** Full sign-in: password → (enrol) → TOTP. Returns the token and the authenticator secret. */
  async function signIn(email: string, password = PASSWORD, secret?: string, stepOffset = 0): Promise<{ token: string; secret: string; session: AdminSessionDto }> {
    const login = (await request(admin).post('/admin/v1/auth/login').send({ email, password }).expect(200)).body as AdminLoginResponse;
    const key = login.step === 'enroll' ? login.secret : secret!;
    const code = totpCode(key, totpStep(Date.now()) + stepOffset);
    const session = (await request(admin).post('/admin/v1/auth/mfa').send({ challenge: login.challenge, code }).expect(200)).body as AdminSessionDto;
    return { token: session.token, secret: key, session };
  }

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  let root: { token: string; secret: string; session: AdminSessionDto };

  it('refuses wrong passwords (audited for real staff) and never opens a session on a password alone', async () => {
    await bootstrap('root@ops.example', 'SUPER_ADMIN');
    await request(admin).post('/admin/v1/auth/login').send({ email: 'nobody@ops.example', password: PASSWORD }).expect(401);
    const wrong = await request(admin).post('/admin/v1/auth/login').send({ email: 'root@ops.example', password: 'not-the-password' }).expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');

    const first = (await request(admin).post('/admin/v1/auth/login').send({ email: 'ROOT@ops.example', password: PASSWORD }).expect(200)).body as AdminLoginResponse;
    expect(first.step).toBe('enroll');
    if (first.step !== 'enroll') return;
    expect(first.otpauthUri).toMatch(/^otpauth:\/\/totp\/ZIPTV%20Console%3Aroot%40ops\.example\?secret=[A-Z2-7]+/);
    expect(first).not.toHaveProperty('token');
    const bad = await request(admin).post('/admin/v1/auth/mfa').send({ challenge: first.challenge, code: '000000' }).expect(401);
    expect(bad.body.error.code).toBe('MFA_INVALID');
    await request(admin).post('/admin/v1/auth/mfa').send({ challenge: 'tampered-challenge-value', code: '123456' }).expect(401);
  });

  it('enrols TOTP on first sign-in, then forces the temporary password to be replaced', async () => {
    root = await signIn('root@ops.example');
    expect(root.session.me).toMatchObject({ role: 'SUPER_ADMIN', mustChangePassword: true });
    const blocked = await request(admin).get('/admin/v1/system/overview').set(as(root.token)).expect(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await request(admin).post('/admin/v1/auth/password').set(as(root.token)).send({ currentPassword: PASSWORD, newPassword: 'short' }).expect(400);
    await request(admin).post('/admin/v1/auth/password').set(as(root.token)).send({ currentPassword: PASSWORD, newPassword: 'a-much-longer-passphrase' }).expect(204);
    const overview = (await request(admin).get('/admin/v1/system/overview').set(as(root.token)).expect(200)).body as SystemOverviewDto;
    expect(overview.staff).toEqual({ total: 1, withoutMfa: 0 });
  });

  it('refuses a replayed TOTP code; the next code works', async () => {
    const login = (await request(admin).post('/admin/v1/auth/login').send({ email: 'root@ops.example', password: 'a-much-longer-passphrase' }).expect(200)).body as AdminLoginResponse;
    expect(login.step).toBe('mfa');
    const used = await t.db.selectFrom('staff_users').select('mfa_last_step').where('email', '=', 'root@ops.example').executeTakeFirstOrThrow();
    const replay = totpCode(root.secret, Number(used.mfa_last_step));
    expect((await request(admin).post('/admin/v1/auth/mfa').send({ challenge: login.challenge, code: replay }).expect(401)).body.error.code).toBe('MFA_INVALID');
    const next = totpCode(root.secret, Number(used.mfa_last_step) + 1);
    await request(admin).post('/admin/v1/auth/mfa').send({ challenge: login.challenge, code: next }).expect(200);
  });

  it('enforces the declared access of every console route (401 without a session, 403 without the permission)', async () => {
    const created = (await request(admin).post('/admin/v1/staff').set(as(root.token)).send({ email: 'viewer@ops.example', name: 'Viewer', role: 'VIEW_ONLY' }).expect(201)).body as CreatedStaffDto;
    const viewer = await signIn('viewer@ops.example', created.temporaryPassword);
    await request(admin).post('/admin/v1/auth/password').set(as(viewer.token)).send({ currentPassword: created.temporaryPassword, newPassword: 'viewer-passphrase-ok' }).expect(204);
    const viewerPermissions = new Set(((await request(admin).get('/admin/v1/me').set(as(viewer.token)).expect(200)).body as { permissions: string[] }).permissions);

    expect(admin.adminRoutes.length).toBeGreaterThanOrEqual(15);
    for (const route of admin.adminRoutes) {
      if (route.access === 'public' || route.path === '/auth/logout') continue;
      const path = `/admin/v1${route.path.replace(/:id\b/g, newEntityId())}`;
      const anonymous = await request(admin)[route.method](path).send({});
      expect(anonymous.status, `${route.method} ${route.path} without a session`).toBe(401);
      const asViewer = await request(admin)[route.method](path).set(as(viewer.token)).send({});
      if (route.access !== 'session' && !viewerPermissions.has(route.access)) {
        expect(asViewer.status, `${route.method} ${route.path} as VIEW_ONLY`).toBe(403);
      } else {
        expect([401, 403], `${route.method} ${route.path} as VIEW_ONLY`).not.toContain(asViewer.status);
      }
    }
    // Undeclared paths are not reachable.
    await request(admin).get('/admin/v1/internal/debug').set(as(root.token)).expect(404);
  });

  it('manages staff with guards: no self-demotion; disabling or re-roling signs the member out', async () => {
    expect((await request(admin).patch(`/admin/v1/staff/${root.session.me.id}`).set(as(root.token)).send({ role: 'VIEW_ONLY' }).expect(403)).body.error.message).toMatch(/own role/);
    const created = (await request(admin).post('/admin/v1/staff').set(as(root.token)).send({ email: 'support@ops.example', name: 'Support', role: 'SUPPORT_AGENT' }).expect(201)).body as CreatedStaffDto;
    await request(admin).post('/admin/v1/staff').set(as(root.token)).send({ email: 'support@ops.example', name: 'Again', role: 'VIEW_ONLY' }).expect(409);
    const support = await signIn('support@ops.example', created.temporaryPassword);
    await request(admin).get('/admin/v1/me').set(as(support.token)).expect(200);

    const disabled = (await request(admin).patch(`/admin/v1/staff/${created.staff.id}`).set(as(root.token)).send({ disabled: true }).expect(200)).body as StaffDto;
    expect(disabled.disabled).toBe(true);
    await request(admin).get('/admin/v1/me').set(as(support.token)).expect(401);
    await request(admin).post('/admin/v1/auth/login').send({ email: 'support@ops.example', password: created.temporaryPassword }).expect(401);

    await request(admin).patch(`/admin/v1/staff/${created.staff.id}`).set(as(root.token)).send({ disabled: false }).expect(200);
    const reset = (await request(admin).post(`/admin/v1/staff/${created.staff.id}/reset-mfa`).set(as(root.token)).expect(200)).body as StaffDto;
    expect(reset.mfaEnabled).toBe(false);
  });

  it('support actions on subscribers are audited and take effect at once', async () => {
    const subscriber = ((await request(t.app).post('/api/v1/sessions').send({}).expect(201)).body as SessionDto).token;
    await request(t.app).get('/api/v1/sessions/me').set(as(subscriber)).expect(200);
    const page = (await request(admin).get('/admin/v1/users?limit=10').set(as(root.token)).expect(200)).body as AdminUserPageDto;
    const user = page.items.find((item) => item.isGuest)!;
    const detail = (await request(admin).get(`/admin/v1/users/${user.id}`).set(as(root.token)).expect(200)).body as AdminUserDetailDto;
    expect(detail.sessionsList.length).toBe(1);

    expect((await request(admin).post(`/admin/v1/users/${user.id}/revoke-sessions`).set(as(root.token)).expect(200)).body).toEqual({ revoked: 1 });
    await request(t.app).get('/api/v1/sessions/me').set(as(subscriber)).expect(401);
    // The outbox delivers the in-app notice in the background.
    await waitFor(async () => (await t.db.selectFrom('notifications').select('type').where('owner_id', '=', user.id).executeTakeFirst())?.type === 'account_security');
  }, 20_000);

  it('keeps an append-only, verifiable audit trail', async () => {
    const page = (await request(admin).get('/admin/v1/audit?limit=200').set(as(root.token)).expect(200)).body as AuditPageDto;
    const actions = page.items.map((item) => item.action);
    for (const action of ['staff.created', 'staff.login_failed', 'staff.mfa_enrolled', 'staff.login', 'staff.password_changed', 'staff.updated', 'staff.mfa_reset', 'user.sessions_revoked']) {
      expect(actions).toContain(action);
    }
    const filtered = (await request(admin).get('/admin/v1/audit?action=staff.login&limit=2').set(as(root.token)).expect(200)).body as AuditPageDto;
    expect(filtered.items.every((item) => item.action === 'staff.login')).toBe(true);
    expect(filtered.nextBefore).not.toBeNull();

    const verified = (await request(admin).get('/admin/v1/audit/verify').set(as(root.token)).expect(200)).body as AuditVerificationDto;
    expect(verified).toMatchObject({ intact: true, brokenAt: null });
    expect(verified.checked).toBe(page.items.length);

    // The database refuses edits and deletions…
    await expect(sql`UPDATE admin_audit_logs SET action = 'nothing' WHERE seq = 1`.execute(t.db)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM admin_audit_logs WHERE seq = 1`.execute(t.db)).rejects.toThrow(/append-only/);
    // …and if someone with superuser rights bypasses that, verification pinpoints it.
    await sql`ALTER TABLE admin_audit_logs DISABLE TRIGGER admin_audit_logs_no_update`.execute(t.db);
    await sql`UPDATE admin_audit_logs SET details = '{"role":"VIEW_ONLY"}' WHERE seq = 1`.execute(t.db);
    await sql`ALTER TABLE admin_audit_logs ENABLE TRIGGER admin_audit_logs_no_update`.execute(t.db);
    const tampered = (await request(admin).get('/admin/v1/audit/verify').set(as(root.token)).expect(200)).body as AuditVerificationDto;
    expect(tampered).toMatchObject({ intact: false, brokenAt: { seq: 1, reason: 'entry content was changed' } });
  });

  it('locks an account after repeated wrong codes (per account, whatever the IP); a reset lifts it', async () => {
    const created = (await request(admin).post('/admin/v1/staff').set(as(root.token)).send({ email: 'lock@ops.example', name: 'Lock', role: 'VIEW_ONLY' }).expect(201)).body as CreatedStaffDto;
    const login = (await request(admin).post('/admin/v1/auth/login').send({ email: 'lock@ops.example', password: created.temporaryPassword }).expect(200)).body as AdminLoginResponse;
    for (let i = 0; i < 4; i++) {
      // Different (spoofed) client IPs do not matter: the counter is on the account.
      const wrong = await request(admin).post('/admin/v1/auth/mfa').set('X-Forwarded-For', `203.0.113.${i}`).send({ challenge: login.challenge, code: '000000' });
      expect(wrong.body.error.code).toBe('MFA_INVALID');
    }
    const locked = await request(admin).post('/admin/v1/auth/mfa').send({ challenge: login.challenge, code: '000000' }).expect(429);
    expect(locked.body.error.message).toMatch(/locked/);
    const again = await request(admin).post('/admin/v1/auth/login').send({ email: 'lock@ops.example', password: created.temporaryPassword }).expect(429);
    expect(again.body.error.message).toMatch(/locked/);
    expect((await request(admin).get('/admin/v1/audit?action=staff.login_failed&limit=50').set(as(root.token)).expect(200)).body.items.some((item: { details: { reason?: string } }) => item.details.reason === 'mfa_locked')).toBe(true);

    const reset = (await request(admin).post(`/admin/v1/staff/${created.staff.id}/reset-password`).set(as(root.token)).expect(200)).body as CreatedStaffDto;
    await request(admin).post('/admin/v1/auth/login').send({ email: 'lock@ops.example', password: reset.temporaryPassword }).expect(200);
  });

  it('challenges die with a password reset and cannot be altered', async () => {
    const created = (await request(admin).post('/admin/v1/staff').set(as(root.token)).send({ email: 'race@ops.example', name: 'Race', role: 'VIEW_ONLY' }).expect(201)).body as CreatedStaffDto;
    const login = (await request(admin).post('/admin/v1/auth/login').send({ email: 'race@ops.example', password: created.temporaryPassword }).expect(200)).body as AdminLoginResponse;
    if (login.step !== 'enroll') throw new Error('expected enrolment');
    const code = totpCode(login.secret, totpStep(Date.now()));
    await request(admin).post('/admin/v1/auth/mfa').send({ challenge: `${login.challenge}.x`, code }).expect(401);
    await request(admin).post(`/admin/v1/staff/${created.staff.id}/reset-password`).set(as(root.token)).expect(200);
    expect((await request(admin).post('/admin/v1/auth/mfa').send({ challenge: login.challenge, code }).expect(401)).body.error.code).toBe('INVALID_TOKEN');
  });

  it('the public listener exposes no console routes; sign-out ends the console session', async () => {
    await request(t.app).get('/admin/v1/me').set(as(root.token)).expect(404);
    await request(t.app).post('/admin/v1/auth/login').send({ email: 'root@ops.example', password: 'x' }).expect(404);
    await request(admin).post('/admin/v1/auth/logout').set(as(root.token)).expect(204);
    await request(admin).get('/admin/v1/me').set(as(root.token)).expect(401);
  });
});

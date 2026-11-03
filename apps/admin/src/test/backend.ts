import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AdminLoginResponse, AdminSessionDto, StaffRole } from '@ziptv/contracts';

import type { TestApp } from '../../../server/src/test/harness';

export { ROLE_PERMISSIONS } from '../../../server/src/domain/admin/rbac';

export interface ConsoleBackend {
  url: string;
  server: TestApp;
  /** A signed-in staff member of `role` (TOTP enrolled, temporary password replaced): their console token. */
  staff(role: StaffRole, email?: string): Promise<{ id: string; token: string }>;
  close(): Promise<void>;
}

/**
 * The real console API (admin listener) on a throw-away PostgreSQL database, on a local port.
 * Console UI tests go component → fetch → HTTP → server → database, like the browser.
 * Needs TEST_DATABASE_URL (see apps/server/src/test/harness.ts).
 */
export async function startConsoleBackend(env: Record<string, string> = {}): Promise<ConsoleBackend> {
  const { startTestApp } = await import('../../../server/src/test/harness');
  const { createAdminApp } = await import('../../../server/src/api/admin/admin-app');
  const { createLogger } = await import('../../../server/src/infrastructure/logger');
  const { ScryptPasswordHasher } = await import('../../../server/src/infrastructure/crypto/password-hasher');
  const { PgAdminUnitOfWork } = await import('../../../server/src/infrastructure/persistence/postgres/repositories/admin.repository');
  const { newEntityId } = await import('../../../server/src/domain/shared/ids');
  const { totpCode, totpStep } = await import('../../../server/src/domain/admin/totp');

  const testApp = await startTestApp({ PROBES_ENABLED: 'false', ...env });
  const admin = createAdminApp({ config: testApp.config, logger: createLogger({ log: { level: 'silent' }, env: 'test' }), container: testApp.container });
  const server: Server = createServer(admin);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hasher = new ScryptPasswordHasher({ N: 2 ** 10, r: 8, p: 1 }, 4);
  const call = async <T>(path: string, body: unknown, token?: string): Promise<T> => {
    const response = await fetch(`${url}/admin/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${path} → ${response.status} ${await response.text()}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
  let counter = 0;
  return {
    url,
    server: testApp,
    staff: async (role, email = `${role.toLowerCase()}${++counter}@ops.example`) => {
      const id = newEntityId();
      const temporary = 'initial-password-123';
      const passwordHash = await hasher.hash(temporary);
      await new PgAdminUnitOfWork(testApp.db).run((tx) => tx.staff.create({ id, email, name: role.replace('_', ' ').toLowerCase(), role, passwordHash, now: new Date() }).then(() => undefined));
      const login = await call<AdminLoginResponse>('/auth/login', { email, password: temporary });
      if (login.step !== 'enroll') throw new Error('expected enrolment');
      const session = await call<AdminSessionDto>('/auth/mfa', { challenge: login.challenge, code: totpCode(login.secret, totpStep(Date.now())) });
      await call('/auth/password', { currentPassword: temporary, newPassword: `${email}-passphrase` }, session.token);
      return { id, token: session.token };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await testApp.close();
    },
  };
}

export const hasBackend = Boolean(process.env.TEST_DATABASE_URL);

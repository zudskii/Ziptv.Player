/**
 * Console accounts from the shell (bootstrap and lock-out recovery). Shell access to the server
 * is already full trust; every action is still written to the audit trail (actor "cli").
 *
 *   npm run staff -w @ziptv/server -- create --email ops@example.com --name "Ops" [--role SUPER_ADMIN]
 *   npm run staff -w @ziptv/server -- recover --email ops@example.com   # new temporary password + MFA reset
 * In the Docker image (compiled):
 *   docker compose exec app node server/cli/staff.js create --email ops@example.com --name "Ops"
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { stateHash } from '../domain/admin/audit.js';
import { isStaffRole } from '../domain/admin/rbac.js';
import { normalizeEmail } from '../domain/identity/credentials.js';
import { newEntityId } from '../domain/shared/ids.js';
import { loadConfig } from '../config/env.js';
import { ScryptPasswordHasher } from '../infrastructure/crypto/password-hasher.js';
import { createLogger } from '../infrastructure/logger.js';
import { createDatabase } from '../infrastructure/persistence/postgres/database.js';
import { migrateToLatest } from '../infrastructure/persistence/postgres/migrator.js';
import { PgAdminUnitOfWork } from '../infrastructure/persistence/postgres/repositories/admin.repository.js';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'SUPER_ADMIN' } },
  });
  const command = positionals[0];
  if ((command !== 'create' && command !== 'recover') || !values.email) {
    console.error('Usage: staff create --email <email> --name <name> [--role ROLE] | staff recover --email <email>');
    process.exit(2);
  }
  const role = values.role ?? 'SUPER_ADMIN';
  if (!isStaffRole(role)) throw new Error(`Unknown role ${role}`);

  const config = loadConfig({ ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn', JOBS_ENABLED: 'false' });
  const logger = createLogger(config);
  const database = createDatabase({ url: config.database.url, poolMax: 2 }, logger);
  try {
    await migrateToLatest(database.db, logger);
    const uow = new PgAdminUnitOfWork(database.db);
    const hasher = new ScryptPasswordHasher();
    const password = randomBytes(15).toString('base64url');
    const passwordHash = await hasher.hash(password);
    const email = normalizeEmail(values.email);
    const now = new Date();
    const cli = { actorId: null, actorEmail: 'cli', ip: null, occurredAt: now, beforeHash: null };

    await uow.run(async (tx) => {
      const existing = await tx.staff.findByEmail(email);
      if (command === 'create') {
        if (existing) throw new Error(`${email} already exists — use "recover" to reset it.`);
        const staff = await tx.staff.create({ id: newEntityId(), email, name: values.name?.trim() || email, role, passwordHash, now });
        await tx.audit.append({ ...cli, action: 'staff.created', targetType: 'staff', targetId: staff.id, afterHash: stateHash({ email, role }), details: { email, role, via: 'cli' } });
      } else {
        if (!existing) throw new Error(`${email} is not a staff member.`);
        await tx.staff.update(existing.id, { passwordHash, mustChangePassword: true, mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null, disabledAt: null }, now);
        await tx.staff.resetMfaFailures(existing.id);
        await tx.staffSessions.deleteForStaff(existing.id);
        await tx.audit.append({ ...cli, action: 'staff.recovered', targetType: 'staff', targetId: existing.id, afterHash: null, details: { via: 'cli' } });
      }
    });
    console.log(`${command === 'create' ? 'Created' : 'Recovered'} ${email}.`);
    console.log(`Temporary password (shown once): ${password}`);
    console.log('Sign in to the console: you will set up an authenticator app and choose a new password.');
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

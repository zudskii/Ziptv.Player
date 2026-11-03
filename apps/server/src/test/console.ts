import type { AdminLoginResponse, AdminSessionDto, StaffRole } from '@ziptv/contracts';
import type { Express } from 'express';
import request from 'supertest';

import { totpCode, totpStep } from '../domain/admin/totp.js';
import { newEntityId } from '../domain/shared/ids.js';
import { ScryptPasswordHasher } from '../infrastructure/crypto/password-hasher.js';
import { PgAdminUnitOfWork } from '../infrastructure/persistence/postgres/repositories/admin.repository.js';
import type { TestApp } from './harness.js';

const TEMPORARY = 'initial-password-123';
const hasher = new ScryptPasswordHasher({ N: 2 ** 10, r: 8, p: 1 }, 4);

export interface StaffSession {
  id: string;
  email: string;
  token: string;
  headers: { Authorization: string };
}

/**
 * A ready console session for a new staff member of `role`: created the way the CLI does,
 * TOTP enrolled, temporary password replaced.
 */
export async function staffSession(t: TestApp, admin: Express, email: string, role: StaffRole): Promise<StaffSession> {
  const passwordHash = await hasher.hash(TEMPORARY);
  const id = newEntityId();
  await new PgAdminUnitOfWork(t.db).run((tx) => tx.staff.create({ id, email, name: email.split('@')[0]!, role, passwordHash, now: new Date() }).then(() => undefined));
  const login = (await request(admin).post('/admin/v1/auth/login').send({ email, password: TEMPORARY }).expect(200)).body as AdminLoginResponse;
  if (login.step !== 'enroll') throw new Error('expected enrolment');
  const session = (await request(admin).post('/admin/v1/auth/mfa').send({ challenge: login.challenge, code: totpCode(login.secret, totpStep(Date.now())) }).expect(200)).body as AdminSessionDto;
  const headers = { Authorization: `Bearer ${session.token}` };
  await request(admin).post('/admin/v1/auth/password').set(headers).send({ currentPassword: TEMPORARY, newPassword: `${email}-passphrase` }).expect(204);
  return { id, email, token: session.token, headers };
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newEntityId } from '../../../domain/shared/ids.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../../test/harness.js';
import { PgEmailTokenRepository } from './repositories/email-token.repository.js';
import { PgUserRepository } from './repositories/user.repository.js';

describe.skipIf(!TEST_DATABASE_URL)('PostgreSQL email tokens', () => {
  let testDb: TestDatabase;
  let tokens: PgEmailTokenRepository;
  let users: PgUserRepository;
  let userId: string;
  const now = new Date('2026-03-01T10:00:00Z');
  const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

  beforeAll(async () => {
    testDb = await createTestDatabase();
    tokens = new PgEmailTokenRepository(testDb.database.db);
    users = new PgUserRepository(testDb.database.db);
    userId = (await users.createAccount({ email: 'tokens@example.com', passwordHash: 'h' }))!.id;
  });
  afterAll(async () => testDb?.close());

  const make = async (hash: string, purpose: 'verify_email' | 'reset_password' = 'reset_password', expiresAt = later(60)) => {
    const id = newEntityId();
    await tokens.create({ id, userId, purpose, tokenHash: hash, email: 'tokens@example.com', expiresAt, createdAt: now });
    return id;
  };

  it('finds a token by its hash and nothing else', async () => {
    const id = await make('hash-find');
    expect(await tokens.findByHash('hash-find')).toEqual({ id, userId, purpose: 'reset_password', email: 'tokens@example.com', expiresAt: later(60), usedAt: null });
    expect(await tokens.findByHash('plaintext-secret')).toBeNull();
  });

  it('lets exactly one of many simultaneous consumers win, and none after expiry', async () => {
    const id = await make('hash-race');
    const results = await Promise.all(Array.from({ length: 12 }, () => tokens.consume(id, now)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await tokens.findByHash('hash-race'))?.usedAt).toEqual(now);
    expect(await tokens.consume(id, now)).toBe(false);

    const expiring = await make('hash-expiring', 'reset_password', later(10));
    expect(await tokens.consume(expiring, later(11))).toBe(false); // too late
    expect(await tokens.consume(expiring, later(9))).toBe(true);
  });

  it('replaces a user’s unused tokens of one kind and leaves the others alone', async () => {
    await make('hash-r1', 'reset_password');
    const used = await make('hash-r2', 'reset_password');
    await tokens.consume(used, now);
    await make('hash-v1', 'verify_email');

    await tokens.invalidateForUser(userId, 'reset_password');
    expect(await tokens.findByHash('hash-r1')).toBeNull(); // unused: gone
    expect(await tokens.findByHash('hash-r2')).not.toBeNull(); // used: kept (a replay still reads "used")
    expect(await tokens.findByHash('hash-v1')).not.toBeNull(); // other purpose: untouched
  });

  it('purges expired tokens only, and goes with its user', async () => {
    await make('hash-old', 'verify_email', later(-5));
    await make('hash-new', 'verify_email', later(500));
    expect(await tokens.purgeExpired(now)).toBeGreaterThanOrEqual(1);
    expect(await tokens.findByHash('hash-old')).toBeNull();
    expect(await tokens.findByHash('hash-new')).not.toBeNull();

    const other = (await users.createAccount({ email: 'gone@example.com', passwordHash: 'h' }))!.id;
    await tokens.create({ id: newEntityId(), userId: other, purpose: 'verify_email', tokenHash: 'hash-cascade', email: 'gone@example.com', expiresAt: later(60), createdAt: now });
    await users.delete(other);
    expect(await tokens.findByHash('hash-cascade')).toBeNull();
  });

  it('refuses two tokens with the same hash', async () => {
    await make('hash-dup');
    await expect(make('hash-dup')).rejects.toThrow();
  });

  it('confirms an address once, only for accounts', async () => {
    const guest = await users.createGuest();
    await users.markEmailVerified(guest.id, now);
    expect((await users.findById(guest.id))?.emailVerifiedAt).toBeNull(); // a guest has no address to confirm

    await users.markEmailVerified(userId, now);
    await users.markEmailVerified(userId, later(30)); // a second confirmation does not move the date
    expect((await users.findById(userId))?.emailVerifiedAt).toEqual(now);
  });
});

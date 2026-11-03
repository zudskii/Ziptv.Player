import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../../test/harness.js';
import { PgLeaseStore } from './repositories/lease-store.js';

/** The PostgreSQL fallback of the concurrency leases: same contract as Redis, correct under races. */
describe.skipIf(!TEST_DATABASE_URL)('PgLeaseStore', () => {
  let database: TestDatabase;
  let store: PgLeaseStore;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  beforeAll(async () => {
    database = await createTestDatabase();
    store = new PgLeaseStore(database.database.db);
  });
  afterAll(async () => database?.close());

  it('admits up to `limit` holders, refreshes an existing holder, refuses the next one', async () => {
    expect(await store.acquire('k1', 'tv', { limit: 2, ttlMs: 5_000 })).toEqual({ acquired: true, holders: 1 });
    expect(await store.acquire('k1', 'phone', { limit: 2, ttlMs: 5_000 })).toEqual({ acquired: true, holders: 2 });
    expect(await store.acquire('k1', 'tv', { limit: 2, ttlMs: 5_000 })).toEqual({ acquired: true, holders: 2 });
    expect(await store.acquire('k1', 'laptop', { limit: 2, ttlMs: 5_000 })).toEqual({ acquired: false, holders: 2 });
    expect(await store.holders('k1')).toEqual(['phone', 'tv']);
    await store.release('k1', 'phone');
    expect((await store.acquire('k1', 'laptop', { limit: 2, ttlMs: 5_000 })).acquired).toBe(true);
  });

  it('expires holders that stop renewing; renew only works while held', async () => {
    await store.acquire('k2', 'tv', { limit: 1, ttlMs: 300 });
    expect(await store.renew('k2', 'tv', 300)).toBe(true);
    expect(await store.renew('k2', 'other', 300)).toBe(false);
    await sleep(450);
    expect(await store.holders('k2')).toEqual([]);
    expect(await store.renew('k2', 'tv', 300)).toBe(false);
    expect((await store.acquire('k2', 'phone', { limit: 1, ttlMs: 300 })).acquired).toBe(true);
    expect(await store.purgeExpired()).toBeGreaterThanOrEqual(0);
  });

  it('never admits more than `limit` under concurrent acquisitions', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => store.acquire('k3', `device-${i}`, { limit: 2, ttlMs: 5_000 })));
    expect(results.filter((result) => result.acquired)).toHaveLength(2);
    expect(await store.holders('k3')).toHaveLength(2);
  });
});

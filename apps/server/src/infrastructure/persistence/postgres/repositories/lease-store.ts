import { sql, type Kysely } from 'kysely';

import type { LeaseStore } from '../../../../application/ports/lease-store.js';
import type { Database } from '../schema.js';

/**
 * LeaseStore on PostgreSQL — the fallback when no Redis is configured, still correct across
 * instances: an acquisition takes a per-key advisory lock, drops expired holders and counts the
 * rest in one transaction, so two instances cannot both take the last slot. Uses the database's
 * clock (one clock for every instance). Same contract as the Redis (Lua) implementation.
 */
export class PgLeaseStore implements LeaseStore {
  constructor(private readonly db: Kysely<Database>) {}

  acquire(key: string, holder: string, options: { limit: number; ttlMs: number }): Promise<{ acquired: boolean; holders: number }> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`ziptv:lease:${key}`}))`.execute(trx);
      await sql`DELETE FROM leases WHERE key = ${key} AND expires_at <= now()`.execute(trx);
      const live = await sql<{ holder: string }>`SELECT holder FROM leases WHERE key = ${key}`.execute(trx);
      const holders = live.rows.map((row) => row.holder);
      if (!holders.includes(holder) && holders.length >= options.limit) return { acquired: false, holders: holders.length };
      await sql`
        INSERT INTO leases (key, holder, expires_at) VALUES (${key}, ${holder}, now() + ${`${Math.ceil(options.ttlMs)} milliseconds`}::interval)
        ON CONFLICT (key, holder) DO UPDATE SET expires_at = excluded.expires_at`.execute(trx);
      return { acquired: true, holders: holders.includes(holder) ? holders.length : holders.length + 1 };
    });
  }

  async renew(key: string, holder: string, ttlMs: number): Promise<boolean> {
    const result = await sql`
      UPDATE leases SET expires_at = now() + ${`${Math.ceil(ttlMs)} milliseconds`}::interval
      WHERE key = ${key} AND holder = ${holder} AND expires_at > now()`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n) > 0;
  }

  async release(key: string, holder: string): Promise<void> {
    await sql`DELETE FROM leases WHERE key = ${key} AND holder = ${holder}`.execute(this.db);
  }

  async holders(key: string): Promise<string[]> {
    const rows = await sql<{ holder: string }>`SELECT holder FROM leases WHERE key = ${key} AND expires_at > now() ORDER BY holder`.execute(this.db);
    return rows.rows.map((row) => row.holder);
  }

  /** Housekeeping: expired rows of keys nobody acquires any more. */
  async purgeExpired(): Promise<number> {
    const result = await sql`DELETE FROM leases WHERE expires_at <= now()`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }
}

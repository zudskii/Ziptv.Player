import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { Logger } from '../../../application/ports/logger.js';
import type { Database } from './schema.js';

export type Db = Kysely<Database>;

export interface DatabaseConfig {
  url: string;
  poolMax: number;
}

export interface DatabaseHandle {
  db: Db;
  /** True when the server answers a trivial query (used by the readiness probe). */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Connection pool + typed query builder. Created once in `main.ts` (and by the test
 * harness) and handed to the container, which never creates connections itself.
 */
export function createDatabase(config: DatabaseConfig, logger: Logger): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: config.url,
    max: config.poolMax,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000,
    // A long-running query must not hold a connection (and a row lock) forever.
    statement_timeout: 120_000,
  });
  // Idle clients can be dropped by the server (restart, failover): log, the pool reconnects.
  pool.on('error', (error) => logger.error({ err: error }, 'PostgreSQL pool error'));

  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  return {
    db,
    ping: async () => {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    close: () => db.destroy(),
  };
}

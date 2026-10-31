import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';
import pg from 'pg';
import type { Response as SupertestResponse } from 'supertest';

import { createApp } from '../api/app.js';
import type { Clock } from '../application/ports/clock.js';
import type { Mailer } from '../application/ports/mailer.js';
import type { PasswordHasher } from '../application/ports/password-hasher.js';
import { ScryptPasswordHasher } from '../infrastructure/crypto/password-hasher.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import { buildContainer, type Container } from '../container.js';
import { createLogger } from '../infrastructure/logger.js';
import { createDatabase, type Db, type DatabaseHandle } from '../infrastructure/persistence/postgres/database.js';
import { migrateToLatest } from '../infrastructure/persistence/postgres/migrator.js';

/**
 * Real PostgreSQL for repository/e2e tests: CI provides a postgres service; locally set
 * TEST_DATABASE_URL to any server where the user may CREATE DATABASE, e.g.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
 * Every test app gets its own freshly migrated database, dropped afterwards.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export interface TestDatabase {
  database: DatabaseHandle;
  url: string;
  close(): Promise<void>;
}

/** A new database on the test server, migrated to the latest schema unless `migrate: false`. */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const adminUrl = TEST_DATABASE_URL!;
  const name = `ziptv_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const withAdmin = async (run: (client: pg.Client) => Promise<void>) => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await run(client);
    } finally {
      await client.end();
    }
  };
  await withAdmin((client) => client.query(`CREATE DATABASE ${name}`).then(() => undefined));

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const logger = createLogger({ log: { level: process.env.TEST_LOG_LEVEL ?? 'silent' }, env: 'test' });
  const database = createDatabase({ url: url.toString(), poolMax: 10 }, logger);
  if (options.migrate !== false) await migrateToLatest(database.db, logger);
  return {
    database,
    url: url.toString(),
    close: async () => {
      await database.close();
      await withAdmin((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).then(() => undefined));
    },
  };
}

export interface TestApp {
  app: Express;
  container: Container;
  config: AppConfig;
  /** The test database, for assertions about what is (not) stored. */
  db: Db;
  close(): Promise<void>;
}

export async function startTestApp(
  env: Record<string, string> = {},
  options: { clock?: Clock; passwordHasher?: PasswordHasher; mailer?: Mailer | null; /** Collects every log line at debug level. */ logLines?: string[] } = {},
): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgres://unused',
    STREAM_TOKEN_SECRET: 's'.repeat(40),
    DATA_ENCRYPTION_KEY: 'k'.repeat(40),
    ALLOW_PRIVATE_UPSTREAMS: 'true',
    CORS_ORIGINS: 'http://localhost:5173',
    ...env,
  });
  const logLines = options.logLines;
  const logger = logLines
    ? createLogger({ log: { level: 'debug' }, env: 'test' }, { write: (line: string) => void logLines.push(line) })
    : createLogger({ log: { level: process.env.TEST_LOG_LEVEL ?? 'silent' }, env: 'test' });
  const testDb = await createTestDatabase();
  const container = buildContainer(config, logger, {
    db: testDb.database.db,
    ...(options.clock ? { clock: options.clock } : {}),
    // Cheap scrypt: tests create many accounts; production parameters would take minutes.
    passwordHasher: options.passwordHasher ?? new ScryptPasswordHasher({ N: 2 ** 10, r: 8, p: 1 }, 4),
    ...(options.mailer !== undefined ? { mailer: options.mailer } : {}),
  });
  const app = createApp({ config, logger, container, isReady: () => true });
  return {
    app,
    container,
    config,
    db: testDb.database.db,
    close: async () => {
      await container.dispose();
      await testDb.close();
    },
  };
}

export interface FakeOrigin {
  url: string;
  server: Server;
  close(): Promise<void>;
}

/** A local HTTP server standing in for an IPTV provider. */
export async function startOrigin(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<FakeOrigin> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Collects a binary body (supertest's default parsers only handle text/JSON). */
export const binaryParser = ((res: NodeJS.ReadableStream, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
  res.on('error', (error: Error) => callback(error, Buffer.alloc(0)));
}) as unknown as (res: SupertestResponse, callback: (error: Error | null, body: unknown) => void) => void;

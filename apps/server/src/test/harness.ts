import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';
import mongoose from 'mongoose';
import type { Response as SupertestResponse } from 'supertest';

import { createApp } from '../api/app.js';
import type { Clock } from '../application/ports/clock.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import { buildContainer, type Container } from '../container.js';
import { createLogger } from '../infrastructure/logger.js';
import { applyMigrations, syncIndexes } from '../infrastructure/persistence/mongo/init.js';

/** Real Mongo for repository/e2e tests: CI provides a mongo service; locally set TEST_MONGO_URI. */
export const TEST_MONGO_URI = process.env.TEST_MONGO_URI;

export interface TestApp {
  app: Express;
  container: Container;
  config: AppConfig;
  close(): Promise<void>;
}

export async function startTestApp(env: Record<string, string> = {}, options: { clock?: Clock } = {}): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGO_URI: TEST_MONGO_URI ?? 'mongodb://unused',
    STREAM_TOKEN_SECRET: 's'.repeat(40),
    DATA_ENCRYPTION_KEY: 'k'.repeat(40),
    ALLOW_PRIVATE_UPSTREAMS: 'true',
    CORS_ORIGINS: 'http://localhost:5173',
    ...env,
  });
  const logger = createLogger({ log: { level: process.env.TEST_LOG_LEVEL ?? 'silent' }, env: 'test' });
  await mongoose.connect(TEST_MONGO_URI!, { dbName: `ziptv_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}` });
  const container = buildContainer(config, logger, { clock: options.clock });
  await syncIndexes();
  await applyMigrations(container.secrets, logger);
  const app = createApp({ config, logger, container, isReady: () => true });
  return {
    app,
    container,
    config,
    close: async () => {
      await container.dispose();
      await mongoose.connection.dropDatabase().catch(() => undefined);
      await mongoose.disconnect();
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

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

import { createApp } from './api/app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { buildContainer } from './container.js';
import { connectDatabase, disconnectDatabase, isDatabaseReady } from './infrastructure/database.js';
import { createLogger } from './infrastructure/logger.js';
import { applyMigrations, syncIndexes } from './infrastructure/persistence/mongo/init.js';

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  // Local development convenience; in production the platform injects the environment.
  if (existsSync('.env')) process.loadEnvFile('.env');

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config);
  if (config.stream.ephemeralSecret) {
    logger.warn('STREAM_TOKEN_SECRET is not set: using a random key, proxy links break on every restart.');
  }
  if (config.encryption.insecureDevKey) {
    logger.warn('DATA_ENCRYPTION_KEY is not set: using the built-in development key. Never run like this in production.');
  }

  await connectDatabase(config.mongo.uri, logger);
  const container = buildContainer(config, logger);
  await syncIndexes();
  if (config.mongo.runMigrations) {
    const applied = await applyMigrations(container.secrets, logger);
    if (applied.length > 0) logger.info({ applied }, 'Database migrations applied');
  }

  const runsApi = config.role !== 'worker';
  const runsJobs = config.role !== 'api' && config.jobs.enabled;

  const app = createApp({ config, logger, container, isReady: isDatabaseReady });
  const server = createServer(app);
  // Must outlive the load balancer's idle timeout (Render/ALB: 60 s) to avoid random 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // A worker-only instance still answers health probes on the same port.
  server.listen(config.http.port, config.http.host, () => {
    logger.info({ port: config.http.port, env: config.env, role: config.role, api: runsApi, jobs: runsJobs }, 'ZIPTV server listening');
  });
  if (runsJobs) container.jobs.start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Stop accepting; idle keep-alive sockets go now, live streams get a grace period.
    server.close(() => {
      void Promise.allSettled([container.dispose()]).then(async () => {
        await disconnectDatabase().catch(() => undefined);
        logger.info('Shutdown complete');
        process.exit(0);
      });
    });
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
    setTimeout(() => {
      logger.error('Forced exit after shutdown timeout');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS + 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  console.error('Fatal startup error', error);
  process.exit(1);
});

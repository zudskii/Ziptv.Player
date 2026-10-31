import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

import express from 'express';

import { createAdminApp } from './api/admin/admin-app.js';
import { createApp } from './api/app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { buildContainer } from './container.js';
import { createLogger } from './infrastructure/logger.js';
import { createDatabase } from './infrastructure/persistence/postgres/database.js';
import { migrateToLatest } from './infrastructure/persistence/postgres/migrator.js';

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

  const database = createDatabase({ url: config.database.url, poolMax: config.database.poolMax }, logger);
  if (config.database.runMigrations) {
    const applied = await migrateToLatest(database.db, logger);
    if (applied.length > 0) logger.info({ applied }, 'Database migrations applied');
  }
  logger.info('PostgreSQL ready');
  const container = buildContainer(config, logger, { db: database.db });

  const runsApi = config.role !== 'worker';
  const runsJobs = config.role !== 'api' && config.jobs.enabled;

  // A worker instance serves no API at all — only health probes (and runs jobs).
  const app = runsApi ? createApp({ config, logger, container, isReady: database.ping }) : healthOnlyApp(database.ping);
  const server = createServer(app);
  // Must outlive the load balancer's idle timeout (Render/ALB: 60 s) to avoid random 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // A worker-only instance still answers health probes on the same port.
  server.listen(config.http.port, config.http.host, () => {
    logger.info({ port: config.http.port, env: config.env, role: config.role, api: runsApi, jobs: runsJobs }, 'ZIPTV server listening');
  });
  if (runsJobs) container.jobs.start();

  // Operator console on its own listener (own origin; firewall it / keep it on a VPN).
  const adminServer = runsApi && config.admin.port > 0 ? createServer(createAdminApp({ config, logger, container })) : null;
  // A console that cannot bind (port taken) must not take the public app down with it.
  adminServer?.on('error', (error) => logger.error({ err: error, port: config.admin.port }, 'Operator console listener failed — console unavailable on this instance'));
  adminServer?.listen(config.admin.port, config.admin.host, () => {
    logger.info({ port: config.admin.port, host: config.admin.host }, 'Operator console listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    adminServer?.close();
    adminServer?.closeAllConnections();
    // Stop accepting; idle keep-alive sockets go now, live streams get a grace period.
    server.close(() => {
      void Promise.allSettled([container.dispose()]).then(async () => {
        await database.close().catch(() => undefined);
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

function healthOnlyApp(isReady: () => Promise<boolean>): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', role: 'worker' });
  });
  app.get('/readyz', async (_req, res) => {
    const ready = await isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'This instance runs background jobs only.' } });
  });
  return app;
}

main().catch((error: unknown) => {
  console.error('Fatal startup error', error);
  process.exit(1);
});

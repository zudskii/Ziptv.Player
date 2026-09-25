import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { buildContainer, initPersistence } from './container.js';
import { connectDatabase, disconnectDatabase, isDatabaseReady } from './infrastructure/database.js';
import { createLogger } from './infrastructure/logger.js';

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

  await connectDatabase(config.mongo.uri, logger);
  await initPersistence();

  const container = buildContainer(config, logger);
  const app = createApp({ config, logger, container, isReady: isDatabaseReady });
  const server = createServer(app);
  // Must outlive the load balancer's idle timeout (Render/ALB: 60 s) to avoid random 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  server.listen(config.http.port, config.http.host, () => {
    logger.info({ port: config.http.port, env: config.env, proxy: config.stream.proxyEnabled }, 'ZIPTV server listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Stop accepting; idle keep-alive sockets go now, live streams get a grace period.
    server.close(() => {
      void Promise.allSettled([container.dispose(), disconnectDatabase()]).then(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      });
    });
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
    setTimeout(() => {
      logger.error('Forced exit after shutdown timeout');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS + 5_000).unref();
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

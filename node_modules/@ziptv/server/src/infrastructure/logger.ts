import { pino, type DestinationStream } from 'pino';

import type { Logger } from '../application/ports/logger.js';
import type { AppConfig } from '../config/env.js';

export type { Logger };

/** Structured JSON logs in production, pretty logs in development. Secrets are redacted. */
export function createLogger(config: Pick<AppConfig, 'log' | 'env'>, destination?: DestinationStream): Logger {
  const options = {
    level: config.log.level,
    base: { service: 'ziptv-server' },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie', '*.token', '*.password', '*.credential', '*.locator'],
      censor: '[redacted]',
    },
    transport:
      config.env === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' } }
        : undefined,
  };
  return destination ? pino({ ...options, transport: undefined }, destination) : pino(options);
}

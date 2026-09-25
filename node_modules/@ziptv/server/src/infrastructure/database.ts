import mongoose from 'mongoose';

import type { Logger } from './logger.js';

export async function connectDatabase(uri: string, logger: Logger): Promise<void> {
  mongoose.set('strictQuery', true);

  const connection = mongoose.connection;
  connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  connection.on('error', (error: unknown) => logger.error({ err: error }, 'MongoDB connection error'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15_000,
    maxPoolSize: 20,
  });
  logger.info({ db: connection.name }, 'MongoDB connected');
}

export function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { vi } from 'vitest';

import type { Mailer } from '../../../server/src/application/ports/mailer';

export interface Backend {
  /** e.g. http://127.0.0.1:41234 */
  url: string;
  close(): Promise<void>;
}

/**
 * The real API on a real (throw-away) PostgreSQL database, listening on a local port, with the
 * client pointed at it. UI tests therefore exercise the same code path as the browser: component →
 * hook → fetch → HTTP → server → database. Needs TEST_DATABASE_URL (see apps/server/src/test/harness.ts).
 *
 * Call before importing any client module: `config.ts` reads the API address when it loads.
 */
export async function startBackend(env: Record<string, string> = {}, options: { mailer?: Mailer | null } = {}): Promise<Backend> {
  const { startTestApp } = await import('../../../server/src/test/harness');
  const testApp = await startTestApp({ TRUST_PROXY: '1', ...env }, options);
  const server: Server = createServer(testApp.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv('VITE_API_URL', url);
  return {
    url,
    close: async () => {
      server.closeAllConnections(); // keep-alive sockets would hold close() open
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await testApp.close();
    },
  };
}

export const hasBackend = Boolean(process.env.TEST_DATABASE_URL);

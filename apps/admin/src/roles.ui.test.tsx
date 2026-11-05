// @vitest-environment jsdom
import type { StaffPermission, StaffRole } from '@ziptv/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { App } from './App';
import { t } from './i18n';
import { consoleSession } from './lib/api';
import { AuthProvider } from './lib/auth';
import { NAV, visibleNav } from './lib/nav';
import { hasBackend, ROLE_PERMISSIONS, startConsoleBackend, type ConsoleBackend } from './test/backend';

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const ROLES = Object.keys(ROLE_PERMISSIONS) as StaffRole[];

/**
 * Console per role, in a browser DOM against the real server: each role sees exactly the
 * sections its permissions allow, every section it can open loads without a permission error
 * (the UI only calls APIs the role may use), and every other section is refused.
 */
describe.skipIf(!hasBackend)('Console by role (9 · RBAC)', () => {
  let backend: ConsoleBackend;
  const realFetch = globalThis.fetch;
  /** Every console API call of the current test, with its status. */
  let calls: { path: string; status: number }[] = [];

  beforeAll(async () => {
    backend = await startConsoleBackend();
    // The console calls same-origin paths (/admin/v1/…): send them to the test server.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const relative = typeof input === 'string' && input.startsWith('/');
      const response = await realFetch(relative ? `${backend.url}${input}` : input, init);
      if (relative) calls.push({ path: `${init?.method ?? 'GET'} ${input}`, status: response.status });
      return response;
    }) as typeof fetch;
  }, 60_000);
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await backend?.close();
  });
  afterEach(() => {
    cleanup();
    consoleSession.set(null);
  });

  const renderAt = (path: string) =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

  for (const role of ROLES) {
    it(`${role}: navigation and sections match the role's permissions`, async () => {
      const permissions = new Set<StaffPermission>(ROLE_PERMISSIONS[role] as StaffPermission[]);
      const expected = visibleNav((permission) => permissions.has(permission));
      const { token } = await backend.staff(role);
      consoleSession.set(token);
      calls = [];

      const view = renderAt('/');
      const nav = await screen.findByRole('navigation', { name: 'Console navigation' });
      await waitFor(() => expect(within(nav).getAllByRole('link').map((link) => link.textContent?.replace(/\d+$/, '').trim())).toEqual(expected.map((item) => t(item.label))));
      view.unmount();

      for (const item of NAV) {
        const page = renderAt(item.to);
        if (expected.includes(item)) {
          // The section loads, and nothing on it was refused by the API.
          await screen.findByRole('heading', { level: 1 });
          await new Promise((resolve) => setTimeout(resolve, 150));
          await waitFor(() => expect(screen.queryByText(/Spinner|Loading…/)).toBeNull(), { timeout: 5_000 }).catch(() => undefined);
          const alerts = screen.queryAllByRole('alert').map((alert) => alert.textContent ?? '');
          expect(alerts.filter((text) => /permission|role|forbidden|403/i.test(text)), `${role} on ${item.to}`).toEqual([]);
          expect(screen.queryByText('Your role does not include this section.'), `${role} on ${item.to}`).toBeNull();
        } else {
          expect(await screen.findByText('Your role does not include this section.'), `${role} on ${item.to}`).toBeTruthy();
        }
        page.unmount();
      }
      // The UI never asked for something the role may not have (no 401/403 anywhere).
      expect(calls.filter((call) => call.status === 401 || call.status === 403), role).toEqual([]);
      expect(calls.length).toBeGreaterThan(expected.length);
    }, 60_000);
  }
});

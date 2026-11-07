// @vitest-environment jsdom
import type { ProviderDto } from '@ziptv/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { App } from './App';
import { consoleSession } from './lib/api';
import { AuthProvider } from './lib/auth';
import { hasBackend, startConsoleBackend, type ConsoleBackend } from './test/backend';

/** What the test uses of the server's reference vendor (loaded at run time, like the rest of the test backend). */
interface ReferenceVendorFeed {
  keyId: string;
  publicKey: string;
  upsert(kind: 'channels' | 'vod' | 'packages', value: Record<string, unknown> & { id: string }): void;
  handle(req: IncomingMessage, res: ServerResponse): void;
}

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.removeAttribute('open');
};

/**
 * Provider onboarding in the console (Phase 16.4), against the real server and a reference vendor
 * feed: the add dialog takes the feed address and the vendor's signing key; the provider page shows
 * the sync journal, conflicts and what the feed delivered.
 */
describe.skipIf(!hasBackend)('Vendor feed onboarding in the console', () => {
  let backend: ConsoleBackend;
  let vendor: ReferenceVendorFeed;
  let feed: Server;
  let feedUrl = '';
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    backend = await startConsoleBackend({ JOBS_ENABLED: 'true', CONSOLE_FOUR_EYES: 'false' });
    backend.server.container.jobs.start();
    const { ReferenceVendorFeed: Feed } = await import('../../server/src/test/reference-vendor-feed');
    vendor = new Feed('studio-one');
    vendor.upsert('channels', { id: 'news', name: 'Studio News', stream: { url: 'http://cdn.example/news.m3u8' } });
    vendor.upsert('channels', { id: 'odd', name: 'Odd', stream: { url: 'http://cdn.example/odd.m3u8' }, rights: [{ territories: ['XYZ'], devices: ['web'], models: ['subscription'], start: '2026-01-01T00:00:00Z' }] });
    vendor.upsert('vod', { id: 'm1', type: 'movie', title: 'Premiere', stream: { url: 'http://cdn.example/m1.mp4' }, packages: ['gold'] });
    vendor.upsert('packages', { id: 'gold', name: 'Gold' });
    feed = createServer((req, res) => vendor.handle(req, res));
    await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve));
    feedUrl = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/feed`;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? `${backend.url}${input}` : input, init)) as typeof fetch;
    consoleSession.set((await backend.staff('SUPER_ADMIN')).token);
  }, 60_000);
  afterAll(async () => {
    globalThis.fetch = realFetch;
    consoleSession.set(null);
    feed?.close();
    await backend?.close();
  });
  afterEach(() => cleanup());

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

  it('adds a signed vendor feed and shows its journal, conflicts and content', { timeout: 60_000 }, async () => {
    const user = userEvent.setup();
    renderAt('/providers');
    await user.click(await screen.findByRole('button', { name: /Add provider/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Studio One');
    await user.selectOptions(within(dialog).getByLabelText('Integration'), 'vendor_feed');
    await user.type(within(dialog).getByLabelText('Feed URL'), feedUrl);
    await user.clear(within(dialog).getByLabelText('Signing key id'));
    await user.type(within(dialog).getByLabelText('Signing key id'), vendor.keyId);
    await user.type(within(dialog).getByLabelText('Vendor public key (Ed25519)'), vendor.publicKey);
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    // The provider page: its slug must match the feed's provider id.
    await screen.findByRole('heading', { name: 'Studio One' });
    const providers = (await (await realFetch(`${backend.url}/admin/v1/providers`, { headers: { authorization: `Bearer ${consoleSession.token}` } })).json()) as ProviderDto[];
    expect(providers.find((provider) => provider.name === 'Studio One')?.slug).toBe('studio-one');

    const journal = await screen.findByRole('table', { name: 'Sync journal' }, { timeout: 30_000 });
    await waitFor(() => expect(within(journal).getByText('sync_ok')).toBeTruthy(), { timeout: 30_000 });
    expect(within(journal).getByText('items_skipped')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/1 stream\(s\) wait for review/)).toBeTruthy(), { timeout: 30_000 });
    expect(screen.getByText(/territory "XYZ"/)).toBeTruthy();
    const packages = await screen.findByRole('table', { name: 'Packages' });
    expect(within(packages).getByText('Gold')).toBeTruthy();
    expect(screen.getByText('Signing keys')).toBeTruthy();
  });
});

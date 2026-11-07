// @vitest-environment jsdom
import type { PackageDto, PromoCodeDto } from '@ziptv/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { App } from './App';
import { consoleSession } from './lib/api';
import { AuthProvider } from './lib/auth';
import { hasBackend, startConsoleBackend, type ConsoleBackend } from './test/backend';

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.removeAttribute('open');
};

/**
 * Plans as configuration (Phase 17), in the console against the real server: a plan's VOD mode,
 * quality, catch-up and prices per country are set in the dialog; promo codes are made and stopped.
 */
describe.skipIf(!hasBackend)('Plans and promo codes in the console', () => {
  let backend: ConsoleBackend;
  const realFetch = globalThis.fetch;
  const read = async <T,>(path: string) => (await (await realFetch(`${backend.url}/admin/v1${path}`, { headers: { authorization: `Bearer ${consoleSession.token}` } })).json()) as T;

  beforeAll(async () => {
    backend = await startConsoleBackend({ CONSOLE_FOUR_EYES: 'false' });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? `${backend.url}${input}` : input, init)) as typeof fetch;
    consoleSession.set((await backend.staff('SUPER_ADMIN')).token);
  }, 60_000);
  afterAll(async () => {
    globalThis.fetch = realFetch;
    consoleSession.set(null);
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

  it('creates a plan with VOD, a quality ceiling, catch-up days and a price for Germany', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    renderAt('/packages');
    await user.click(await screen.findByRole('button', { name: /New package/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Premium');
    await user.type(within(dialog).getByLabelText('Base price'), '19.99');
    await user.selectOptions(within(dialog).getByLabelText('Films & series'), 'included');
    await user.selectOptions(within(dialog).getByLabelText('Picture quality'), 'fhd');
    await user.type(within(dialog).getByLabelText('Catch-up days'), '3');
    await user.click(within(dialog).getByRole('button', { name: /Add a country/ }));
    await user.type(within(dialog).getByLabelText('Country'), 'de');
    const currencies = within(dialog).getAllByLabelText('Currency');
    await user.clear(currencies[1]!);
    await user.type(currencies[1]!, 'eur');
    await user.clear(within(dialog).getByLabelText('Price'));
    await user.type(within(dialog).getByLabelText('Price'), '7.99');
    await user.click(within(dialog).getByRole('button', { name: 'Request approval' }));

    await waitFor(async () => expect((await read<PackageDto[]>('/packages')).some((pkg) => pkg.name === 'Premium')).toBe(true));
    const [created] = await read<PackageDto[]>('/packages');
    expect(created).toMatchObject({ billingPeriod: 'month', vodMode: 'included', maxQuality: 'fhd', catchupDays: 3, prices: [{ country: 'DE', currency: 'EUR', priceMinor: 799 }], version: 1 });
    const table = await screen.findByRole('table', { name: 'Packages' });
    await waitFor(() => expect(within(table).getByText('Premium')).toBeTruthy());
    expect(within(table).getByText('Included')).toBeTruthy();
    expect(within(table).getByText(/Full HD \(1080p\) · 3 days/)).toBeTruthy();
  });

  it('makes a promo code for a plan and stops it', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    renderAt('/packages');
    await user.click(await screen.findByRole('button', { name: /New promo code/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Code'), 'spring');
    await user.type(within(dialog).getByLabelText('Percent off'), '25');
    await user.click(within(dialog).getByLabelText('Premium'));
    await user.type(within(dialog).getByLabelText('Uses at most'), '100');
    await user.click(within(dialog).getByRole('button', { name: 'Request approval' }));

    const table = await screen.findByRole('table', { name: 'Promo codes' });
    await waitFor(() => expect(within(table).getByText('SPRING')).toBeTruthy());
    expect(within(table).getByText('25 % off')).toBeTruthy();
    expect(within(table).getByText('0 / 100')).toBeTruthy();
    await user.click(within(table).getByRole('button', { name: 'Stop' }));
    await waitFor(async () => expect((await read<PromoCodeDto[]>('/promo-codes'))[0]).toMatchObject({ code: 'SPRING', active: false }));
    await waitFor(() => expect(within(table).getByText('Stopped')).toBeTruthy());
  });
});

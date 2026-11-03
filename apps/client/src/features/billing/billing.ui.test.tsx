// @vitest-environment jsdom
import '../../test/ui-env';

import type { AuthSessionDto } from '@ziptv/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { hasBackend, startBackend, type Backend } from '../../test/backend';

const redirects: string[] = [];
vi.mock('../../lib/redirect', () => ({ redirectTo: (url: string) => void redirects.push(url) }));

/** Imported only after the backend is up: config.ts reads the API address when it loads. */
async function loadUi() {
  return {
    ...(await import('../../pages/billing/PlansPage')),
    ...(await import('../../pages/billing/BillingReturnPage')),
    ...(await import('../../pages/billing/AccountPage')),
    ...(await import('../session/session')),
    ...(await import('../../lib/query-client')),
    ...(await import('./components/PlaybackAccessNotice')),
    ...(await import('./access-notice')),
    ...(await import('./api')),
  };
}

describe.skipIf(!hasBackend)('Plans, checkout return and subscription screens against the real server', () => {
  let backend: Backend;
  let ui: Awaited<ReturnType<typeof loadUi>>;
  let counter = 0;

  beforeAll(async () => {
    backend = await startBackend();
    ui = await loadUi();
    ui.installSessionAuth();
    // Packages are made in the console; seed one directly.
    const now = new Date();
    await backend.server.db
      .insertInto('packages')
      .values({ id: '0190f1a2-0000-7000-8000-00000000b051', slug: 'basic', name: 'Basic', description: 'News and sport', price_minor: 999, currency: 'GEL', billing_period: 'month', trial_days: 0, max_devices: 3, max_streams: 2, business_model: 'subscription', status: 'active', created_at: now })
      .execute();
  });
  afterAll(async () => {
    await backend.close();
  });
  beforeEach(() => {
    redirects.length = 0;
    localStorage.clear();
    ui.useSessionStore.setState({ token: null, account: null });
    ui.queryClient.clear();
  });
  afterEach(() => cleanup());

  const signUp = async () => {
    const email = `buyer${++counter}@example.com`;
    const response = await fetch(`${backend.url}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.0.${counter}` }, body: JSON.stringify({ email, password: 'correct horse battery' }) });
    const session = (await response.json()) as AuthSessionDto;
    ui.useSessionStore.setState({ token: session.token, account: { email } });
    return session;
  };
  const renderAt = (path: string) =>
    render(
      <QueryClientProvider client={ui.queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/plans" element={<ui.PlansPage />} />
            <Route path="/billing/return" element={<ui.BillingReturnPage />} />
            <Route path="/account" element={<ui.AccountPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('a guest sees the plans but must create an account to buy', async () => {
    const guest = await fetch(`${backend.url}/api/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    ui.useSessionStore.setState({ token: ((await guest.json()) as { token: string }).token, account: null });
    renderAt('/plans');
    const plan = await screen.findByRole('listitem', { name: 'Basic' });
    expect(within(plan).getByText(/2 streams at once · 3 devices/)).toBeTruthy();
    expect(within(plan).getByRole('button', { name: /subscribe/i }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /create account/i })).toBeTruthy();
  });

  it('subscribe → processor page → back: "confirming" until the payment is verified, then subscribed', async () => {
    const user = userEvent.setup();
    await signUp();
    renderAt('/plans');
    await user.click(await within(await screen.findByRole('listitem', { name: 'Basic' })).findByRole('button', { name: /subscribe/i }));
    await waitFor(() => expect(redirects).toHaveLength(1));
    const page = new URL(redirects[0]!);
    expect(page.pathname).toMatch(/^\/billing\/fake-checkout\/fcs_/);
    cleanup();

    // Back on the return page without having paid: nothing is granted.
    const checkout = await backend.server.db.selectFrom('checkouts').select(['id', 'processor_ref']).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    renderAt(`/billing/return?checkout=${checkout.id}`);
    expect(await screen.findByText('Confirming your payment…')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(screen.getByText('Confirming your payment…')).toBeTruthy();

    // The customer pays on the processor's page; the page polls until the server has verified it.
    backend.server.container.commerce.fakeProcessor!.pay(checkout.processor_ref!);
    expect(await screen.findByText('You are subscribed', {}, { timeout: 6_000 })).toBeTruthy();
    expect(screen.getByText(/Basic is ready to watch/)).toBeTruthy();
  }, 15_000);

  it('the account page cancels at period end and resumes', async () => {
    const user = userEvent.setup();
    await signUp();
    const started = await ui.billingApi.startCheckout('0190f1a2-0000-7000-8000-00000000b051');
    backend.server.container.commerce.fakeProcessor!.pay(new URL(started.redirectUrl).pathname.split('/').pop()!);
    await waitFor(async () => expect((await ui.billingApi.checkout(started.checkoutId)).status).toBe('completed'));

    renderAt('/account');
    expect(await screen.findByText(/Renews on/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel subscription' }));
    expect(await screen.findByText(/Canceled — you can watch until/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Resume subscription' }));
    expect(await screen.findByText(/Renews on/)).toBeTruthy();
  });

  it('the player explains a refused stream: subscribe, or stop the other device and watch here', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const stop = vi.spyOn(ui.billingApi, 'stopSession').mockResolvedValue(undefined);
    expect(ui.accessNotice({ code: 'NOT_ENTITLED', apiDetails: { reason: 'no_subscription' }, message: '' })).toMatchObject({ title: 'Subscription required', kind: 'subscribe' });
    expect(ui.accessNotice({ code: 'NOT_ENTITLED', apiDetails: { reason: 'territory' }, message: '' })).toBeNull();
    render(
      <MemoryRouter>
        <ui.PlaybackAccessActions
          failure={{ code: 'CONCURRENCY_LIMIT', message: 'Your plan allows 1 simultaneous stream.', apiDetails: { limit: 1, playing: [{ playbackSessionId: 'ps-tv', deviceId: 'd', deviceName: 'Living room TV', channelId: 'c', startedAt: new Date().toISOString() }] } }}
          onRetry={onRetry}
        />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Stop playback on Living room TV and watch here' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalled());
    expect(stop).toHaveBeenCalledWith('ps-tv');
    stop.mockRestore();
  });
});

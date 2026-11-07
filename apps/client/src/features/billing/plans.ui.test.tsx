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
    ...(await import('../../pages/billing/AccountPage')),
    ...(await import('../../pages/films/FilmsPage')),
    ...(await import('../../pages/films/FilmDetailsPage')),
    ...(await import('../session/session')),
    ...(await import('../../lib/query-client')),
    ...(await import('./api')),
  };
}

const BASIC = '0190f1a2-0000-7000-8000-0000000017b1';
const PREMIUM = '0190f1a2-0000-7000-8000-0000000017b2';
const PROVIDER = '0190f1a2-0000-7000-8000-0000000017c1';
const FILM = '0190f1a2-0000-7000-8000-0000000017d1';

/**
 * Phase 17 screens against the real server: plans say what they include (VOD, quality, catch-up),
 * a promo code is quoted per plan, a subscriber switches plans with the prorated price shown first,
 * and the operator's films say "In your plan" or "Upgrade" — all decided by the server's one engine.
 */
describe.skipIf(!hasBackend)('Plans, promo codes, plan switch and the films catalogue against the real server', () => {
  let backend: Backend;
  let ui: Awaited<ReturnType<typeof loadUi>>;
  let counter = 0;

  beforeAll(async () => {
    backend = await startBackend();
    ui = await loadUi();
    ui.installSessionAuth();
    const now = new Date();
    const plan = { description: '', currency: 'GEL', billing_period: 'month' as const, trial_days: 0, max_devices: 3, max_streams: 2, business_model: 'subscription' as const, status: 'active' as const, created_at: now };
    await backend.server.db
      .insertInto('packages')
      .values([
        { ...plan, id: BASIC, slug: 'basic-17', name: 'Basic', price_minor: 999, max_quality: 'hd', catchup_days: 1, vod_mode: 'none' },
        { ...plan, id: PREMIUM, slug: 'premium-17', name: 'Premium', price_minor: 1999, vod_mode: 'included' },
      ])
      .execute();
    await backend.server.db.insertInto('promo_codes').values({ id: '0190f1a2-0000-7000-8000-0000000017e1', code: 'WELCOME', kind: 'percent', value: 50, families: [PREMIUM] }).execute();
    await backend.server.db.insertInto('providers').values({ id: PROVIDER, slug: 'studio-17', name: 'Studio', integration_type: 'vendor_feed', sync_status: 'idle' }).execute();
    const right = { territories: ['*'], devices: ['web'], models: ['subscription'], start: new Date(Date.now() - 86_400_000).toISOString(), end: null, catchupDays: 0, maxQuality: null };
    await backend.server.db
      .insertInto('provider_vod')
      .values({ id: FILM, provider_id: PROVIDER, external_id: 'f1', type: 'movie', title: 'Night Train', year: 2021, genres: ['Drama'], plot: 'A long night.', rights: JSON.stringify([right]) as never })
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
    const email = `plans${++counter}@example.com`;
    const response = await fetch(`${backend.url}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.17.0.${counter}` }, body: JSON.stringify({ email, password: 'correct horse battery' }) });
    const session = (await response.json()) as AuthSessionDto;
    ui.useSessionStore.setState({ token: session.token, account: { email } });
    return session;
  };
  const subscribe = async (packageId: string) => {
    const started = await ui.billingApi.startCheckout({ packageId });
    backend.server.container.commerce.fakeProcessor!.pay(new URL(started.redirectUrl).pathname.split('/').pop()!);
    await waitFor(async () => expect((await ui.billingApi.checkout(started.checkoutId)).status).toBe('completed'));
  };
  const renderAt = (path: string) =>
    render(
      <QueryClientProvider client={ui.queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/plans" element={<ui.PlansPage />} />
            <Route path="/account" element={<ui.AccountPage />} />
            <Route path="/films" element={<ui.FilmsPage />} />
            <Route path="/films/:id" element={<ui.FilmDetailsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('each plan says what it includes: films, picture quality, catch-up', async () => {
    await signUp();
    renderAt('/plans');
    const basic = await screen.findByRole('listitem', { name: 'Basic' });
    expect(within(basic).getByText('Up to HD')).toBeTruthy();
    expect(within(basic).getByText('1 day of catch-up')).toBeTruthy();
    expect(within(basic).queryByText(/Films & series/)).toBeNull();
    const premium = screen.getByRole('listitem', { name: 'Premium' });
    expect(within(premium).getByText('Films & series included')).toBeTruthy();
    expect(within(premium).queryByText(/Up to/)).toBeNull();
  });

  it('a promo code is quoted on every plan and carried into the checkout of the one it applies to', async () => {
    const user = userEvent.setup();
    await signUp();
    renderAt('/plans');
    await user.type(await screen.findByLabelText('Promo code'), 'welcome');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    const premium = screen.getByRole('listitem', { name: 'Premium' });
    expect(await within(premium).findByText(/First payment .*9\.99.* with WELCOME/)).toBeTruthy();
    expect(await within(screen.getByRole('listitem', { name: 'Basic' })).findByText('The code does not apply to this plan.')).toBeTruthy();
    await user.click(within(premium).getByRole('button', { name: /subscribe/i }));
    await waitFor(() => expect(redirects).toHaveLength(1));
    const checkout = await backend.server.db.selectFrom('checkouts').select(['promo_id', 'discount_minor', 'amount_minor']).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(checkout).toMatchObject({ discount_minor: 1000, amount_minor: 1999 });
    expect(checkout.promo_id).not.toBeNull();
  });

  it('a subscriber switches plans after seeing the prorated price; the films catalogue follows', async () => {
    const user = userEvent.setup();
    await signUp();
    await subscribe(BASIC);

    renderAt('/films');
    const film = await screen.findByRole('link', { name: /Night Train/ });
    expect(within(film).getByText('Upgrade')).toBeTruthy();
    cleanup();
    renderAt(`/films/${FILM}`);
    expect(await screen.findByText('Included in Premium.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
    cleanup();

    renderAt('/plans');
    const premium = await screen.findByRole('listitem', { name: 'Premium' });
    await user.click(await within(premium).findByRole('button', { name: 'Switch to this plan' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Charged now for the rest of this period:/)).toBeTruthy();
    expect(within(dialog).getByText(/From Basic to Premium/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Switch now' }));
    await waitFor(() => expect(within(screen.getByRole('listitem', { name: 'Premium' })).getByText('Your plan')).toBeTruthy());
    cleanup();

    renderAt('/films');
    // The switch invalidated the catalogue: it refetches with the new plan.
    await waitFor(() => expect(within(screen.getByRole('link', { name: /Night Train/ })).getByText('In your plan')).toBeTruthy());
    cleanup();
    renderAt(`/films/${FILM}`);
    expect(await screen.findByRole('button', { name: 'Play' })).toBeTruthy();
  });
});

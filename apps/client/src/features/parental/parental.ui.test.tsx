// @vitest-environment jsdom
import '../../test/ui-env';

import type { AuthSessionDto, ProfileDto } from '@ziptv/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { hasBackend, startBackend, type Backend } from '../../test/backend';

/** Imported only after the backend is up: config.ts reads the API address when it loads. */
async function loadUi() {
  return {
    ...(await import('./ParentalSection')),
    ...(await import('./PinDialog')),
    ...(await import('./gate-recovery')),
    ...(await import('./parental-store')),
    ...(await import('../profiles/ProfileSwitcher')),
    ...(await import('../profiles/profile-store')),
    ...(await import('../session/session')),
    ...(await import('../../lib/query-client')),
    ...(await import('../../lib/api-client')),
  };
}

/**
 * Parental controls in the browser, against the real server: setting the PIN, opening a
 * protected profile through the PIN dialog (wrong PIN first), and a device held in a kids
 * profile being brought back to it by the gate recovery.
 */
describe.skipIf(!hasBackend)('Parental controls UI against the real server', () => {
  let backend: Backend;
  let ui: Awaited<ReturnType<typeof loadUi>>;
  let token = '';
  const api = async <T,>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> => {
    const response = await fetch(`${backend.url}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  };

  beforeAll(async () => {
    backend = await startBackend();
    ui = await loadUi();
    ui.installSessionAuth();
    ui.installProfileHeaders();
    ui.installGateRecovery();
    const response = await fetch(`${backend.url}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'family@example.com', password: 'correct horse battery' }) });
    token = ((await response.json()) as AuthSessionDto).token;
    ui.useSessionStore.setState({ token, account: { email: 'family@example.com' } });
  });
  afterAll(async () => {
    await backend?.close();
  });
  afterEach(() => cleanup());

  const renderUi = (children: React.ReactNode) =>
    render(
      <QueryClientProvider client={ui.queryClient}>
        <MemoryRouter>
          {children}
          <ui.PinDialog />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('sets the PIN from Settings (two equal entries, not a trivial one)', async () => {
    const user = userEvent.setup();
    renderUi(<ui.ParentalSection />);
    const pin = await screen.findByLabelText('PIN (4–8 digits)');
    await user.type(pin, '1234');
    await user.type(screen.getByLabelText('Repeat PIN'), '1234');
    await user.click(screen.getByRole('button', { name: 'Set PIN' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/harder to guess/);
    await user.clear(pin);
    await user.type(pin, '4826');
    await user.clear(screen.getByLabelText('Repeat PIN'));
    await user.type(screen.getByLabelText('Repeat PIN'), '4826');
    await user.click(screen.getByRole('button', { name: 'Set PIN' }));
    expect(await screen.findByText('PIN is set')).toBeTruthy();
    expect(screen.getByLabelText('Rules for')).toBeTruthy();
  });

  it('opening a protected profile asks for the PIN; a wrong one is explained', async () => {
    const user = userEvent.setup();
    const work = await api<ProfileDto>('/api/v1/profiles', { method: 'POST', body: { name: 'Work' } });
    await api(`/api/v1/profiles/${work.id}`, { method: 'PATCH', body: { pinProtected: true, pin: '4826' } });
    // Protecting it opened it on that device; this one is a fresh sign-in.
    const second = await fetch(`${backend.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'family@example.com', password: 'correct horse battery' }) });
    ui.useSessionStore.setState({ token: ((await second.json()) as AuthSessionDto).token, account: { email: 'family@example.com' } });
    ui.queryClient.clear();

    renderUi(<ui.ProfileSwitcher />);
    await user.click(await screen.findByRole('button', { name: /^Profile: / }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Work/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Enter the PIN' });
    await user.type(within(dialog).getByLabelText('PIN'), '0000');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Wrong PIN. Try again.');
    await user.type(within(dialog).getByLabelText('PIN'), '4826');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(ui.useProfileStore.getState().profileId).toBe(work.id));
    expect(await ui.apiRequest('/api/v1/me/list')).toMatchObject({ items: [] });
  });

  it('a device held in a kids profile goes back to it when another profile is requested', async () => {
    const kids = await api<ProfileDto>('/api/v1/profiles', { method: 'POST', body: { name: 'Kids', kind: 'kids' } });
    await ui.apiRequest(`/api/v1/profiles/${kids.id}/access`, { method: 'POST', body: {} });
    // Without a selection the server answers as the kids profile, and says so in the profile list.
    ui.useProfileStore.setState({ profileId: null });
    expect((await ui.apiRequest<ProfileDto[]>('/api/v1/profiles')).find((profile) => profile.heldHere)?.id).toBe(kids.id);
    // Another profile is refused on this device; the client switches back to the kids profile and repeats.
    const main = (await ui.apiRequest<ProfileDto[]>('/api/v1/profiles')).find((profile) => profile.isDefault)!;
    ui.useProfileStore.setState({ profileId: main.id });
    await ui.apiRequest('/api/v1/home');
    expect(ui.useProfileStore.getState().profileId).toBe(kids.id);
  });
});

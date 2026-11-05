// @vitest-environment jsdom
import '../../test/ui-env';

import type { AuthSessionDto, ProfileDto, ProfileLibraryDto, SourceDto, SourceProfilesDto } from '@ziptv/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { hasBackend, startBackend, type Backend } from '../../test/backend';

/** Imported only after the backend is up: config.ts reads the API address when it loads. */
async function loadUi() {
  return {
    ...(await import('./ProfilesSection')),
    ...(await import('../../pages/SourcesPage')),
    ...(await import('../sources/components/AddSourceForm')),
    ...(await import('../parental/PinDialog')),
    ...(await import('./profile-store')),
    ...(await import('../session/session')),
    ...(await import('../../lib/query-client')),
  };
}

const PLAYLIST = (name: string) => `#EXTM3U\n#EXTINF:-1 group-title="News",${name} News\nhttp://example.com/${name}.m3u8\n`;

/**
 * Per-profile library in the browser, against the real server: Profile → Library, Settings →
 * Sources ("who sees it"), the PIN for kids profiles, and "add for every profile".
 */
describe.skipIf(!hasBackend)('Profile library UI against the real server', () => {
  let backend: Backend;
  let ui: Awaited<ReturnType<typeof loadUi>>;
  let token = '';
  let main: ProfileDto;
  let bob: ProfileDto;
  let kids: ProfileDto;
  let alpha: SourceDto;
  let beta: SourceDto;
  const realFetch = globalThis.fetch;
  let sent: { path: string; body: unknown }[] = [];

  const api = async <T,>(path: string, init: { method?: string; body?: unknown; profileId?: string } = {}): Promise<T> => {
    const response = await realFetch(`${backend.url}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.profileId ? { 'x-profile-id': init.profileId } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
  /** Multipart by hand: jsdom replaces FormData/Blob with versions Node's fetch cannot send. */
  const upload = async (name: string) => {
    const boundary = '----ziptvtest';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}.m3u"\r\nContent-Type: audio/x-mpegurl\r\n\r\n${PLAYLIST(name)}\r\n--${boundary}--\r\n`,
    );
    const response = await realFetch(`${backend.url}/api/v1/sources/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
    return (await response.json()) as SourceDto;
  };

  beforeAll(async () => {
    backend = await startBackend();
    ui = await loadUi();
    ui.installSessionAuth();
    ui.installProfileHeaders();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET' && typeof init.body === 'string') sent.push({ path: new URL(String(input)).pathname, body: JSON.parse(init.body) });
      return realFetch(input, init);
    }) as typeof fetch;
    const response = await realFetch(`${backend.url}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'library@example.com', password: 'correct horse battery' }) });
    token = ((await response.json()) as AuthSessionDto).token;
    ui.useSessionStore.setState({ token, account: { email: 'library@example.com' } });
    [main] = await api<ProfileDto[]>('/profiles');
    bob = await api<ProfileDto>('/profiles', { method: 'POST', body: { name: 'Bob' } });
    kids = await api<ProfileDto>('/profiles', { method: 'POST', body: { name: 'Kids', kind: 'kids' } });
    alpha = await upload('Alpha'); // the main profile's only
    beta = await upload('Beta');
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await backend?.close();
  });
  afterEach(() => {
    cleanup();
    sent = [];
    ui.queryClient.clear();
  });

  const renderUi = (children: React.ReactNode) =>
    render(
      <QueryClientProvider client={ui.queryClient}>
        <MemoryRouter>
          {children}
          <ui.PinDialog />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it("Profile → Library picks the sources a kids profile sees (it starts with none)", async () => {
    const user = userEvent.setup();
    renderUi(<ui.ProfilesSection />);
    await user.click(await screen.findByRole('button', { name: 'Library of Kids' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Library' }).getAttribute('aria-checked')).toBe('true');
    const alphaBox = await within(dialog).findByRole('checkbox', { name: /Alpha/ });
    expect((alphaBox as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getByText('0 of 2 selected')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    await user.click(alphaBox);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await api<ProfileLibraryDto>(`/profiles/${kids.id}/library`)).sourceIds).toEqual([alpha.id]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it("with a PIN, changing a kids profile's library asks for it", async () => {
    await api('/me/parental/pin', { method: 'PUT', body: { pin: '4826' } });
    const user = userEvent.setup();
    renderUi(<ui.ProfilesSection />);
    await user.click(await screen.findByRole('button', { name: 'Library of Kids' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('checkbox', { name: /Beta/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    const pin = await screen.findByLabelText('PIN');
    await user.type(pin, '4826');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(async () => expect((await api<ProfileLibraryDto>(`/profiles/${kids.id}/library`)).sourceIds.sort()).toEqual([alpha.id, beta.id].sort()));
  });

  it('Settings → Sources lists the whole account and changes who sees a source', async () => {
    // Bob's library: only Beta. As Bob, Alpha is listed but marked as not in this profile.
    await api(`/profiles/${bob.id}/library`, { method: 'PUT', body: { sourceIds: [beta.id] } });
    ui.useProfileStore.getState().select(bob.id);
    const user = userEvent.setup();
    renderUi(<ui.SourcesPage />);
    const alphaCard = await screen.findByRole('article', { name: 'Alpha' });
    expect(within(alphaCard).getByText('Not in this profile')).toBeTruthy();
    expect(within(alphaCard).getByText(/Seen by Me, Kids|Seen by Kids and Me|Seen by Me and Kids/)).toBeTruthy();
    expect(within(await screen.findByRole('article', { name: 'Beta' })).queryByText('Not in this profile')).toBeNull();

    await user.click(within(alphaCard).getByRole('button', { name: 'Change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Who sees this source' });
    expect((within(dialog).getByRole('checkbox', { name: /Me/ }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(dialog).getByRole('checkbox', { name: /Bob/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await api<SourceProfilesDto>(`/sources/${alpha.id}/profiles`)).profileIds).toContain(bob.id));
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'Alpha' })).queryByText('Not in this profile')).toBeNull());
    ui.useProfileStore.getState().select(null);
  });

  it('adding a source asks whether the other profiles see it too', async () => {
    ui.useProfileStore.getState().select(main!.id);
    const user = userEvent.setup();
    renderUi(<ui.AddSourceForm onAdded={() => undefined} />);
    const forAll = await screen.findByRole('checkbox', { name: /Add it for the other profiles too/ });
    expect(screen.getByText(/Only “Me” will see it/)).toBeTruthy();
    await user.click(forAll);
    expect(screen.getByText(/Also visible to Bob/)).toBeTruthy();
    await user.type(screen.getByLabelText('Playlist URL'), 'https://provider.example/list.m3u');
    await user.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(sent.find((item) => item.path === '/api/v1/sources')?.body).toMatchObject({ type: 'm3u_url', audience: 'all' }));
    // Kids profiles are never added by "everyone".
    await waitFor(async () => expect((await api<SourceDto[]>('/sources?scope=account')).find((source) => source.origin.kind === 'url')?.profileIds.sort()).toEqual([main!.id, bob.id].sort()));
    ui.useProfileStore.getState().select(null);
  });
});

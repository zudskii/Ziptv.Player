// @vitest-environment jsdom
import '../../test/ui-env';

import type { AuthSessionDto, SessionDto, SourceDto } from '@ziptv/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { hasBackend, startBackend, type Backend } from '../../test/backend';

const PASSWORD = 'correct horse battery';
const PLAYLIST = '#EXTM3U\n#EXTINF:-1 group-title="News",One\nhttp://example.com/1.m3u8\n';

/** Imported only after the backend is up: config.ts reads the API address when it loads. */
async function loadUi() {
  return {
    ...(await import('../../pages/auth/AuthPage')),
    ...(await import('../../pages/onboarding/WelcomePage')),
    ...(await import('../sources/components/NoSourcesState')),
    ...(await import('../session/SessionGate')),
    ...(await import('./components/AccountSection')),
    ...(await import('../session/session')),
    ...(await import('../../lib/query-client')),
    ...(await import('../sources/api')),
  };
}

describe.skipIf(!hasBackend)('Sign-in screens against the real server', () => {
  let backend: Backend;
  let fetchLog: { method: string; path: string }[] = [];
  /** Paths whose responses are held back, to make "submitted before it finished loading" deterministic. */
  let slow: string[] = [];
  const realFetch = globalThis.fetch;
  let ui: Awaited<ReturnType<typeof loadUi>>;
  let counter = 0;
  const nextEmail = () => `ui${++counter}@example.com`;
  const ip = () => `10.1.${(++counter >> 8) & 255}.${counter & 255}`;

  beforeAll(async () => {
    backend = await startBackend();
    ui = await loadUi();
    ui.installSessionAuth();
    // Record every request the app makes, to prove what it did *not* do (e.g. start a new guest).
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      fetchLog.push({ method: (init?.method ?? 'GET').toUpperCase(), path });
      if (slow.includes(path)) await new Promise((resolve) => setTimeout(resolve, 1500));
      return realFetch(input, init);
    }) as typeof fetch;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await backend.close();
  });
  beforeEach(() => {
    fetchLog = [];
    slow = [];
    localStorage.clear();
    ui.useSessionStore.setState({ token: null, account: null, signedOut: false });
    ui.queryClient.clear();
  });
  afterEach(() => cleanup());

  // --- helpers --------------------------------------------------------------------------------

  const api = async <T,>(path: string, token: string | null, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> => {
    const response = await realFetch(`${backend.url}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: response.status, body: (response.status === 204 ? null : await response.json()) as T };
  };
  const newGuest = async () => (await api<SessionDto>('/sessions', null, { method: 'POST', body: {} })).body.token;
  const newAccount = async (email = nextEmail()) => ({ email, token: (await api<AuthSessionDto>('/auth/register', null, { method: 'POST', body: { email, password: PASSWORD } })).body.token });
  /** Multipart by hand: jsdom replaces FormData/Blob with versions Node's fetch cannot send. */
  const addSource = async (token: string) => {
    const boundary = '----ziptvtest';
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="list.m3u"\r\nContent-Type: audio/x-mpegurl\r\n\r\n${PLAYLIST}\r\n--${boundary}--\r\n`);
    const response = await realFetch(`${backend.url}/api/v1/sources/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': ip(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    return (await response.json()) as SourceDto;
  };

  function Where() {
    const location = useLocation();
    return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
  }
  function renderAt(path: string, state?: unknown, extra?: React.ReactNode) {
    const { AuthPage, SessionGate, WelcomePage, queryClient } = ui;
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[{ pathname: path, state }]}>
          <Where />
          <Routes>
            <Route path="/login" element={<AuthPage mode="login" />} />
            <Route path="/register" element={<AuthPage mode="register" />} />
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/" element={<p>Home screen</p>} />
            <Route path="/private" element={<SessionGate>{extra ?? <p>Private area</p>}</SessionGate>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }
  const where = () => screen.getByTestId('where').textContent;
  /** The sign-in pages ask the server what it can do (a public GET, no session needed); anything else is a real action. */
  const actions = () => fetchLog.filter((entry) => entry.path !== '/api/v1/auth/features');
  const posted = (path: string) => fetchLog.filter((entry) => entry.method === 'POST' && entry.path === path);

  // --- registration ---------------------------------------------------------------------------

  it('creates an account, signs the device in and leaves the register page', async () => {
    const user = userEvent.setup();
    renderAt('/register');
    const email = nextEmail();
    await user.type(screen.getByLabelText('Email'), email);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Repeat the password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await screen.findByText('Home screen');
    const { token, account } = ui.useSessionStore.getState();
    expect(account).toEqual({ email });
    expect((await api<{ email: string; isGuest: boolean }>('/sessions/me', token)).body).toMatchObject({ email, isGuest: false });
  });

  it('tells what is wrong before sending anything', async () => {
    const user = userEvent.setup();
    renderAt('/register');
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByText('Use at least 8 characters.')).toBeTruthy();
    expect(actions().filter((entry) => entry.path.startsWith('/api/v1/auth'))).toEqual([]);
  });

  it('keeps everything a guest added when it registers, and retires the guest token', async () => {
    const guest = await newGuest();
    await addSource(guest);
    ui.useSessionStore.getState().setGuest(guest);

    const user = userEvent.setup();
    renderAt('/register');
    await user.type(screen.getByLabelText('Email'), nextEmail());
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Repeat the password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByText('Home screen');

    const token = ui.useSessionStore.getState().token!;
    expect((await api<SourceDto[]>('/sources', token)).body).toHaveLength(1);
    expect((await api('/sessions/me', guest)).status).toBe(401);
  });

  it('says so, and offers the sign-in, when the email is already registered', async () => {
    const { email } = await newAccount();
    const user = userEvent.setup();
    renderAt('/register');
    await user.type(screen.getByLabelText('Email'), email);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Repeat the password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/already exists/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in instead' })).toBeTruthy();
    expect(ui.useSessionStore.getState().account).toBeNull();
  });

  // --- signing in -----------------------------------------------------------------------------

  it('a wrong password is an error message, never a new identity: the guest session is untouched', async () => {
    const { email } = await newAccount();
    const guest = await newGuest();
    ui.useSessionStore.getState().setGuest(guest);
    fetchLog = [];

    const user = userEvent.setup();
    renderAt('/login');
    await user.type(screen.getByLabelText('Email'), email);
    await user.type(screen.getByLabelText('Password'), 'definitely wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Invalid email or password.')).toBeTruthy();
    expect(ui.useSessionStore.getState()).toMatchObject({ token: guest, account: null });
    expect(posted('/api/v1/sessions')).toEqual([]); // the 401 did not trigger "renew my session"
    expect((await api('/sessions/me', guest)).status).toBe(200);
  });

  it('signs in and returns to the page the person came from — never to another site', async () => {
    const { email } = await newAccount();
    const user = userEvent.setup();
    renderAt('/login', { from: '//evil.example/steal' });
    await user.type(screen.getByLabelText('Email'), email);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Home screen');
    expect(where()).toBe('/');
    expect(ui.useSessionStore.getState().account).toEqual({ email });
  });

  it('brings the guest’s sources and playlists into the account when asked', async () => {
    const { email, token: accountToken } = await newAccount();
    const guest = await newGuest();
    await addSource(guest);
    await api('/playlists', guest, { method: 'POST', body: { name: 'On this device' } });
    ui.useSessionStore.getState().setGuest(guest);

    const user = userEvent.setup();
    renderAt('/login');
    const box = await screen.findByRole('checkbox', { name: /Bring what is on this device/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(await screen.findByText('1 source and 1 playlist')).toBeTruthy(); // the two counts arrive as separate requests
    await user.type(screen.getByLabelText('Email'), email);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Home screen');

    expect((await api<SourceDto[]>('/sources', accountToken)).body).toHaveLength(1);
    expect((await api<{ name: string }[]>('/playlists', accountToken)).body.map((p) => p.name)).toEqual(['On this device']);
  });

  it('merges even when the form is submitted before the guest’s data finished loading', async () => {
    const { email, token: accountToken } = await newAccount();
    const guest = await newGuest();
    await api('/playlists', guest, { method: 'POST', body: { name: 'Only a playlist' } });
    ui.useSessionStore.getState().setGuest(guest);
    slow = ['/api/v1/playlists']; // the playlists are still loading when the person clicks

    const user = userEvent.setup();
    renderAt('/login');
    await user.type(screen.getByLabelText('Email'), email);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    expect(screen.queryByRole('checkbox', { name: /Bring what is on this device/ })).toBeNull(); // nothing known yet
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Home screen');
    expect((await api<{ name: string }[]>('/playlists', accountToken)).body.map((p) => p.name)).toEqual(['Only a playlist']);
  });

  it('leaves the guest data alone when the box is unticked', async () => {
    const { email, token: accountToken } = await newAccount();
    const guest = await newGuest();
    await addSource(guest);
    ui.useSessionStore.getState().setGuest(guest);

    const user = userEvent.setup();
    renderAt('/login');
    await user.click(await screen.findByRole('checkbox', { name: /Bring what is on this device/ }));
    await user.type(screen.getByLabelText('Email'), email);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Home screen');
    expect((await api<SourceDto[]>('/sources', accountToken)).body).toHaveLength(0);
  });

  it('does not open a session just by showing the sign-in page', async () => {
    renderAt('/login');
    await screen.findByRole('button', { name: 'Sign in' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(actions()).toEqual([]);
    expect(ui.useSessionStore.getState().token).toBeNull();
  });

  // --- when the session ends ------------------------------------------------------------------

  function Sources() {
    const sources = ui.useSources();
    return <p>{sources.isSuccess ? `Sources: ${sources.data.length}` : sources.isError ? 'Sources failed' : 'Loading sources'}</p>;
  }

  it('asks an account to sign in again when its session ends — it does not start an empty guest', async () => {
    ui.useSessionStore.setState({ token: 'x'.repeat(43), account: { email: 'gone@example.com' } }); // the server rejects this token
    renderAt('/private', undefined, <Sources />);

    expect(await screen.findByText(/Your session ended/)).toBeTruthy();
    expect(where()).toBe('/login');
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('gone@example.com');
    expect(ui.useSessionStore.getState()).toMatchObject({ token: null, account: { email: 'gone@example.com' } });
    expect(posted('/api/v1/sessions')).toEqual([]);
  });

  it('after signing in again, returns to where the person was', async () => {
    const { email } = await newAccount();
    ui.useSessionStore.setState({ token: 'x'.repeat(43), account: { email } });
    const user = userEvent.setup();
    renderAt('/private', undefined, <Sources />);

    await screen.findByText(/Your session ended/);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Sources: 0')).toBeTruthy();
    expect(where()).toBe('/private');
  });

  it('still starts a new guest silently when a guest token is rejected (nothing to lose)', async () => {
    ui.useSessionStore.setState({ token: 'y'.repeat(43), account: null });
    renderAt('/private', undefined, <Sources />);
    expect(await screen.findByText('Sources: 0')).toBeTruthy();
    expect(posted('/api/v1/sessions')).toHaveLength(1);
    expect(ui.useSessionStore.getState().token).not.toBe('y'.repeat(43));
  });

  it('a first visit goes to the welcome page and creates nothing until the person chooses', async () => {
    renderAt('/private');
    expect(await screen.findByRole('heading', { name: 'Welcome to ZIPTV' })).toBeTruthy();
    expect(where()).toBe('/welcome');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(posted('/api/v1/sessions')).toEqual([]);
    expect(ui.useSessionStore.getState().token).toBeNull();
  });

  it('continue as guest starts a guest and returns to the page the person opened', async () => {
    const user = userEvent.setup();
    renderAt('/private');
    await user.click(await screen.findByRole('button', { name: 'Continue as guest' }));
    expect(await screen.findByText('Private area')).toBeTruthy();
    expect(where()).toBe('/private');
    expect(posted('/api/v1/sessions')).toHaveLength(1);
    expect(ui.useSessionStore.getState()).toMatchObject({ account: null, signedOut: false });
  });

  it('the welcome page is never shown to a device that has a session', async () => {
    ui.useSessionStore.getState().setGuest(await newGuest());
    renderAt('/welcome', { from: '/private' });
    expect(await screen.findByText('Private area')).toBeTruthy();
    expect(where()).toBe('/private');
  });

  it('a request made without any session never creates one behind the person’s back', async () => {
    render(
      <QueryClientProvider client={ui.queryClient}>
        <Sources />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Sources failed')).toBeTruthy();
    expect(posted('/api/v1/sessions')).toEqual([]);
    expect(ui.useSessionStore.getState().token).toBeNull();
  });

  it('a screen without sources explains itself and stays where the person asked to go', async () => {
    ui.useSessionStore.getState().setGuest(await newGuest());
    renderAt('/private', undefined, <ui.NoSourcesState area="movies" />);
    expect(await screen.findByText('No movies yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add a source' }).getAttribute('href')).toBe('/setup');
    expect(where()).toBe('/private');
  });

  // --- signing out ----------------------------------------------------------------------------

  it('signs out: the server forgets the device, the app forgets the account and its cached data, the sign-in page opens', async () => {
    const { email, token } = await newAccount();
    ui.useSessionStore.getState().setAccount(token, email);
    ui.queryClient.setQueryData(['sources'], ['cached for this account']);
    const user = userEvent.setup();
    renderAt('/private', undefined, <ui.AccountSection />);
    expect(await screen.findByText(email)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText(/You signed out/)).toBeTruthy();
    expect(where()).toBe('/login');
    expect(ui.useSessionStore.getState()).toMatchObject({ token: null, account: null, signedOut: true });
    expect(ui.queryClient.getQueryData(['sources'])).toBeUndefined();
    expect((await api('/sessions/me', token)).status).toBe(401);
    // No guest is started behind the person's back, and the last person's page is not remembered.
    expect(posted('/api/v1/sessions')).toEqual([]);
    expect(screen.queryByText('Continue without an account')?.closest('a')?.getAttribute('href')).toBe('/welcome');
  });

  it('signing out in another tab signs this tab out too', async () => {
    const { email, token } = await newAccount();
    ui.useSessionStore.getState().setAccount(token, email);
    ui.queryClient.setQueryData(['sources'], ['cached for this account']);
    renderAt('/private');
    expect(await screen.findByText('Private area')).toBeTruthy();

    // What the other tab leaves in localStorage, and the event this tab receives for it.
    const value = JSON.stringify({ state: { token: null, account: null, signedOut: true }, version: 2 });
    localStorage.setItem('ziptv:session', value);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'ziptv:session', newValue: value }));
    });

    expect(await screen.findByText(/You signed out/)).toBeTruthy();
    expect(where()).toBe('/login');
    expect(ui.queryClient.getQueryData(['sources'])).toBeUndefined();
  });

  it('signing in as someone else in another tab drops this tab’s cached data', async () => {
    const first = await newAccount();
    const second = await newAccount();
    ui.useSessionStore.getState().setAccount(first.token, first.email);
    ui.queryClient.setQueryData(['sources'], ['cached for the first account']);

    const value = JSON.stringify({ state: { token: second.token, account: { email: second.email }, signedOut: false }, version: 2 });
    localStorage.setItem('ziptv:session', value);
    window.dispatchEvent(new StorageEvent('storage', { key: 'ziptv:session', newValue: value }));

    await waitFor(() => expect(ui.useSessionStore.getState().account?.email).toBe(second.email));
    expect(ui.queryClient.getQueryData(['sources'])).toBeUndefined();
  });
});

vi.stubEnv('VITE_API_URL', '');

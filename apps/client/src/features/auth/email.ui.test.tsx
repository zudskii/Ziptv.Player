// @vitest-environment jsdom
import '../../test/ui-env';

import type { AuthSessionDto, MeDto } from '@ziptv/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CapturingMailer } from '../../../../server/src/test/capture-mailer';
import { hasBackend, startBackend, type Backend } from '../../test/backend';

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a completely new passphrase';
const PUBLIC_URL = 'https://tv.example.test';

/** Imported only after the backend is up: config.ts reads the API address when it loads. */
async function loadUi() {
  return {
    ...(await import('../../pages/auth/AuthPage')),
    ...(await import('../../pages/auth/ForgotPasswordPage')),
    ...(await import('../../pages/auth/ResetPasswordPage')),
    ...(await import('../../pages/auth/VerifyEmailPage')),
    ...(await import('./components/AccountSection')),
    ...(await import('../session/session')),
    ...(await import('../../lib/query-client')),
    ...(await import('./api')),
  };
}
type Ui = Awaited<ReturnType<typeof loadUi>>;

/** Everything the screens do, against whichever backend `ui` was loaded for. */
function harness(getUi: () => Ui, getBackend: () => Backend) {
  let counter = 0;
  const log: { method: string; path: string }[] = [];
  const realFetch = globalThis.fetch;
  const ip = () => `10.6.${(++counter >> 8) & 255}.${counter & 255}`;

  const api = async <T,>(path: string, token: string | null, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> => {
    const response = await realFetch(`${getBackend().url}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: response.status, body: (response.status === 204 ? null : await response.json()) as T };
  };

  function Where() {
    const location = useLocation();
    return (
      <>
        <p data-testid="where">{location.pathname}</p>
        <p data-testid="hash">{location.hash}</p>
      </>
    );
  }

  function renderAt(path: string, hash = '') {
    const ui = getUi();
    return render(
      <QueryClientProvider client={ui.queryClient}>
        <MemoryRouter initialEntries={[{ pathname: path, hash }]}>
          <Where />
          <Routes>
            <Route path="/login" element={<ui.AuthPage mode="login" />} />
            <Route path="/register" element={<ui.AuthPage mode="register" />} />
            <Route path="/forgot-password" element={<ui.ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ui.ResetPasswordPage />} />
            <Route path="/verify-email" element={<ui.VerifyEmailPage />} />
            <Route path="/settings" element={<ui.AccountSection />} />
            <Route path="/" element={<p>Home screen</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  return {
    api,
    log,
    renderAt,
    where: () => screen.getByTestId('where').textContent,
    hash: () => screen.getByTestId('hash').textContent,
    posted: (path: string) => log.filter((entry) => entry.method === 'POST' && entry.path === path),
    install() {
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        log.push({ method: (init?.method ?? 'GET').toUpperCase(), path: new URL(String(input)).pathname });
        return realFetch(input, init);
      }) as typeof fetch;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
    nextEmail: () => `email${++counter}@example.com`,
    /** An account made behind the app's back (as if registered earlier). */
    async account(mailer: CapturingMailer, email = `acct${++counter}@example.com`) {
      const before = mailer.sent.length;
      const token = ((await api<AuthSessionDto>('/auth/register', null, { method: 'POST', body: { email, password: PASSWORD } })).body).token;
      const verification = (await mailer.waitFor(before + 1))[before]!;
      return { email, token, verification };
    },
  };
}

describe.skipIf(!hasBackend)('Email links through the real screens (server can send email)', () => {
  const mailer = new CapturingMailer();
  let backend: Backend;
  let ui: Ui;
  const h = harness(() => ui, () => backend);

  beforeAll(async () => {
    backend = await startBackend({ PUBLIC_URL }, { mailer });
    ui = await loadUi();
    ui.installSessionAuth();
    h.install();
  });
  afterAll(async () => {
    h.restore();
    await backend.close();
  });
  beforeEach(() => {
    h.log.length = 0;
    localStorage.clear();
    ui.useSessionStore.setState({ token: null, account: null });
    ui.queryClient.clear();
  });
  afterEach(() => cleanup());

  /** Asks for a reset link on the real page and returns the fragment of the link that arrived. */
  async function requestReset(email: string): Promise<string> {
    const before = mailer.sent.length;
    const user = userEvent.setup();
    h.renderAt('/forgot-password');
    await user.type(await screen.findByLabelText('Email'), email);
    await user.click(screen.getByRole('button', { name: 'Send the link' }));
    await screen.findByText(/we have sent a link/);
    const mail = (await mailer.waitFor(before + 1))[before]!;
    cleanup();
    return new URL(CapturingMailer.linkIn(mail)).hash;
  }

  // --- forgotten password ---------------------------------------------------------------------

  it('forgot → email → new password → sign in with it, end to end', async () => {
    const { email } = await h.account(mailer);
    const fragment = await requestReset(email);
    expect(fragment).toMatch(/^#token=[A-Za-z0-9_-]{43}$/);

    const user = userEvent.setup();
    h.renderAt('/reset-password', fragment);
    await user.type(await screen.findByLabelText('New password'), NEW_PASSWORD);
    await user.type(screen.getByLabelText('Repeat the new password'), NEW_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    // Back at the sign-in page with a notice; the new password works.
    expect(await screen.findByText(/Your password was changed/)).toBeTruthy();
    expect(h.where()).toBe('/login');
    await user.type(screen.getByLabelText('Email'), email);
    await user.type(screen.getByLabelText('Password'), NEW_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Home screen');
    expect(ui.useSessionStore.getState().account).toEqual({ email });
    expect((await h.api('/auth/login', null, { method: 'POST', body: { email, password: PASSWORD } })).status).toBe(401);
  });

  it('says the same thing for an address nobody registered, and sends nothing', async () => {
    const before = mailer.sent.length;
    const user = userEvent.setup();
    h.renderAt('/forgot-password');
    await user.type(await screen.findByLabelText('Email'), 'nobody-registered@example.com');
    await user.click(screen.getByRole('button', { name: 'Send the link' }));
    expect(await screen.findByText(/we have sent a link/)).toBeTruthy();
    await mailer.settle();
    expect(mailer.sent.length).toBe(before);
  });

  it('checks the address on screen before asking the server', async () => {
    const user = userEvent.setup();
    h.renderAt('/forgot-password');
    await user.type(await screen.findByLabelText('Email'), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Send the link' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(h.posted('/api/v1/auth/forgot-password')).toEqual([]);
  });

  it('offers "Forgot your password?" on the sign-in page', async () => {
    h.renderAt('/login');
    const link = await screen.findByRole('link', { name: 'Forgot your password?' });
    expect(link.getAttribute('href')).toBe('/forgot-password');
  });

  it('takes the secret out of the address bar as soon as the page has read it', async () => {
    const { email, verification } = await h.account(mailer);
    const fragment = await requestReset(email);
    h.renderAt('/reset-password', fragment);
    await screen.findByLabelText('New password');
    await waitFor(() => expect(h.hash()).toBe('')); // not left in the URL or the browser history
    cleanup();

    h.renderAt('/verify-email', new URL(CapturingMailer.linkIn(verification)).hash);
    await screen.findByText('Email confirmed');
    expect(h.hash()).toBe('');
  });

  it('refuses a damaged link on the spot, without contacting the server', async () => {
    h.renderAt('/reset-password', '#token=nope');
    expect(await screen.findByText('This link does not work')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Request a new link' }).getAttribute('href')).toBe('/forgot-password');
    expect(h.log.filter((entry) => entry.path.includes('/auth/reset'))).toEqual([]);
  });

  it('keeps the link usable when the new password is refused, and shows why', async () => {
    const { email } = await h.account(mailer);
    const fragment = await requestReset(email);
    const user = userEvent.setup();
    h.renderAt('/reset-password', fragment);
    await user.type(await screen.findByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Repeat the new password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Use at least 8 characters.')).toBeTruthy();
    expect(h.posted('/api/v1/auth/reset-password')).toEqual([]); // stopped before the server

    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), NEW_PASSWORD);
    await user.type(screen.getByLabelText('Repeat the new password'), 'something different');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The passwords do not match.')).toBeTruthy();
    await user.clear(screen.getByLabelText('Repeat the new password'));
    await user.type(screen.getByLabelText('Repeat the new password'), NEW_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    await screen.findByText(/Your password was changed/);
  });

  it('explains a link that was already used and offers a new one', async () => {
    const { email } = await h.account(mailer);
    const fragment = await requestReset(email);
    const user = userEvent.setup();
    h.renderAt('/reset-password', fragment);
    await user.type(await screen.findByLabelText('New password'), NEW_PASSWORD);
    await user.type(screen.getByLabelText('Repeat the new password'), NEW_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    await screen.findByText(/Your password was changed/);
    cleanup();

    h.renderAt('/reset-password', fragment); // the same email opened a second time
    await user.type(await screen.findByLabelText('New password'), 'another long passphrase');
    await user.type(screen.getByLabelText('Repeat the new password'), 'another long passphrase');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/invalid or has expired/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toBeTruthy();
  });

  it('opens from an email on a device with no session, and never starts one', async () => {
    const { email } = await h.account(mailer);
    const fragment = await requestReset(email);
    h.log.length = 0;
    h.renderAt('/reset-password', fragment);
    await screen.findByLabelText('New password');
    h.renderAt('/forgot-password');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.posted('/api/v1/sessions')).toEqual([]);
    expect(ui.useSessionStore.getState().token).toBeNull();
  });

  // --- confirming the address -----------------------------------------------------------------

  it('confirms the address from the email on any device, once', async () => {
    const { token, verification } = await h.account(mailer);
    const fragment = new URL(CapturingMailer.linkIn(verification)).hash;
    h.log.length = 0;

    h.renderAt('/verify-email', fragment);
    expect(await screen.findByText('Email confirmed')).toBeTruthy();
    expect(h.posted('/api/v1/sessions')).toEqual([]); // no session was needed or started
    expect(((await h.api<MeDto>('/sessions/me', token)).body).emailVerified).toBe(true);
    cleanup();

    h.renderAt('/verify-email', fragment); // used: the page says so
    expect(await screen.findByText('This link does not work')).toBeTruthy();
    expect(await screen.findByText(/invalid or has expired/)).toBeTruthy();
  });

  it('confirms only once even though the page may run its effect twice', async () => {
    const { verification } = await h.account(mailer);
    h.log.length = 0;
    h.renderAt('/verify-email', new URL(CapturingMailer.linkIn(verification)).hash);
    await screen.findByText('Email confirmed');
    expect(h.posted('/api/v1/auth/verify-email')).toHaveLength(1);
  });

  it('shows the confirmation status in settings, resends the link, and flips to "confirmed"', async () => {
    const { email, token } = await h.account(mailer);
    ui.useSessionStore.getState().setAccount(token, email);
    const user = userEvent.setup();
    h.renderAt('/settings');

    expect(await screen.findByText('Email not confirmed')).toBeTruthy();
    const before = mailer.sent.length;
    await user.click(screen.getByRole('button', { name: 'Send me the link' }));
    const mail = (await mailer.waitFor(before + 1))[before]!;
    expect(mail.to).toBe(email);

    await h.api('/auth/verify-email', null, { method: 'POST', body: { token: CapturingMailer.tokenIn(mail) } });
    await ui.queryClient.invalidateQueries({ queryKey: ui.authKeys.me });
    expect(await screen.findByText('Email confirmed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send me the link' })).toBeNull();
  });

  it('registering through the screen sends the confirmation email', async () => {
    const before = mailer.sent.length;
    const user = userEvent.setup();
    h.renderAt('/register');
    const email = h.nextEmail();
    await user.type(await screen.findByLabelText('Email'), email);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Repeat the password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByText('Home screen');
    const mail = (await mailer.waitFor(before + 1))[before]!;
    expect(mail.to).toBe(email);
    expect(mail.subject).toMatch(/Confirm/);
  });
});

describe.skipIf(!hasBackend)('Email links through the real screens (server cannot send email)', () => {
  let backend: Backend;
  let ui: Ui;
  const h = harness(() => ui, () => backend);

  beforeAll(async () => {
    vi.resetModules(); // a fresh copy of the app, pointed at the other backend
    backend = await startBackend({}, { mailer: null });
    ui = await loadUi();
    ui.installSessionAuth();
  });
  afterAll(async () => backend.close());
  beforeEach(() => {
    localStorage.clear();
    ui.useSessionStore.setState({ token: null, account: null });
    ui.queryClient.clear();
  });
  afterEach(() => cleanup());

  it('does not offer "Forgot your password?", and the page says why when opened directly', async () => {
    h.renderAt('/login');
    await screen.findByRole('button', { name: 'Sign in' });
    await waitFor(() => expect(ui.queryClient.getQueryData(ui.authKeys.features)).toEqual({ passwordReset: false, emailVerification: false }));
    expect(screen.queryByRole('link', { name: 'Forgot your password?' })).toBeNull();
    cleanup();

    h.renderAt('/forgot-password');
    expect(await screen.findByText(/not set up to send email/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send the link' })).toBeNull();
  });

  it('shows no confirmation status for accounts', async () => {
    const session = (await h.api<AuthSessionDto>('/auth/register', null, { method: 'POST', body: { email: h.nextEmail(), password: PASSWORD } })).body;
    ui.useSessionStore.getState().setAccount(session.token, session.user.email!);
    h.renderAt('/settings');
    expect(await screen.findByText(/Signed in as/)).toBeTruthy();
    await waitFor(() => expect(ui.queryClient.getQueryData(ui.authKeys.features)).toBeDefined());
    expect(screen.queryByText('Email not confirmed')).toBeNull();
    expect(screen.queryByText('Email confirmed')).toBeNull();
  });
});


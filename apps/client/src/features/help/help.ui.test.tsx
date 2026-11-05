// @vitest-environment jsdom
import '../../test/ui-env';

import type { AuthSessionDto, SettingsDto } from '@ziptv/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { IconButton } from '../../components/ui/Button';
import { HelpHint } from '../../components/ui/HelpHint';
import { hasBackend, startBackend, type Backend } from '../../test/backend';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Tooltip on icon buttons', () => {
  it('appears after a short hover, not at once, and leaves with the pointer', () => {
    vi.useFakeTimers();
    render(<IconButton label="Mute">x</IconButton>);
    const button = screen.getByRole('button', { name: 'Mute' });
    expect(button.getAttribute('title')).toBeNull(); // no native tooltip on top of ours
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('Mute');
    fireEvent.pointerLeave(button, { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  it('passing over quickly shows nothing; clicking hides it', () => {
    vi.useFakeTimers();
    render(<IconButton label="Mute">x</IconButton>);
    const button = screen.getByRole('button', { name: 'Mute' });
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.pointerLeave(button, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();

    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerDown(button, { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  it('a long press shows it on touch screens and it goes away by itself', () => {
    vi.useFakeTimers();
    render(<IconButton label="Mute">x</IconButton>);
    const button = screen.getByRole('button', { name: 'Mute' });
    fireEvent.pointerDown(button, { pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    expect(screen.getByRole('tooltip', { hidden: true })).toBeTruthy();
    act(() => vi.advanceTimersByTime(2500));
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();

    // A tap is a tap: no tooltip.
    fireEvent.pointerDown(button, { pointerType: 'touch' });
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  it('keyboard focus shows it at once and Escape hides it without closing what is around it', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    render(
      <div onKeyDown={(event) => event.key === 'Escape' && outer()}>
        <IconButton label="Mute">x</IconButton>
      </div>,
    );
    await user.tab();
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('Mute');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    await user.keyboard('{Escape}'); // nothing left to close: now it reaches the dialog
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('is only visual for icon buttons — the label is already their accessible name', () => {
    vi.useFakeTimers();
    render(<IconButton label="Mute">x</IconButton>);
    const button = screen.getByRole('button', { name: 'Mute' });
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('tooltip', { hidden: true }).getAttribute('aria-hidden')).toBe('true');
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('HelpHint', () => {
  it('opens on click, is announced, and closes on a second click, Escape or a click elsewhere', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <span>Quality</span>
        <HelpHint topic="Quality">Picks the stream quality.</HelpHint>
        <button type="button">Elsewhere</button>
      </div>,
    );
    const hint = screen.getByRole('button', { name: 'About “Quality”' });
    expect(hint.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('status').textContent).toBe('');

    await user.click(hint);
    expect(hint.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Picks the stream quality.');
    await user.click(hint);
    expect(hint.getAttribute('aria-expanded')).toBe('false');

    await user.click(hint);
    await user.keyboard('{Escape}');
    expect(hint.getAttribute('aria-expanded')).toBe('false');

    await user.click(hint);
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(hint.getAttribute('aria-expanded')).toBe('false');
  });
});

/** Imported only after the backend is up: config.ts reads the API address when it loads. */
async function loadUi() {
  return {
    ...(await import('./GetStartedChecklist')),
    ...(await import('./Tour')),
    ...(await import('../../pages/SettingsPage')),
    ...(await import('../profiles/profile-store')),
    ...(await import('../session/session')),
    ...(await import('../../lib/query-client')),
  };
}

/**
 * The get-started checklist, tours and "show tips again", against the real server: what a profile
 * has seen is stored in its settings, so it survives reloads and devices.
 */
describe.skipIf(!hasBackend)('Help state against the real server', () => {
  let backend: Backend;
  let ui: Awaited<ReturnType<typeof loadUi>>;
  let token = '';
  const settings = async () => {
    const response = await fetch(`${backend.url}/api/v1/me/settings`, { headers: { authorization: `Bearer ${token}` } });
    return ((await response.json()) as SettingsDto).help;
  };

  beforeAll(async () => {
    backend = await startBackend();
    ui = await loadUi();
    ui.installSessionAuth();
    ui.installProfileHeaders();
    const response = await fetch(`${backend.url}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'help@example.com', password: 'correct horse battery' }) });
    token = ((await response.json()) as AuthSessionDto).token;
    ui.useSessionStore.setState({ token, account: { email: 'help@example.com' } });
  });
  afterAll(async () => {
    await backend?.close();
  });

  const renderUi = (children: React.ReactNode) =>
    render(
      <QueryClientProvider client={ui.queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>,
    );

  it('the checklist ticks off what is done, links to the rest and can be dismissed for good', async () => {
    const user = userEvent.setup();
    renderUi(<ui.GetStartedChecklist hasSource hasWatched={false} />);
    const list = await screen.findByRole('region', { name: 'Get started' });
    expect(within(list).getByText('1 of 3 done')).toBeTruthy();
    expect(within(list).getByText(/— done/)).toBeTruthy();
    expect(within(list).queryByRole('link', { name: 'Add source' })).toBeNull(); // already done
    expect(within(list).getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('/settings');
    expect(within(list).getByRole('link', { name: 'Browse channels' }).getAttribute('href')).toBe('/live');

    await user.click(within(list).getByRole('button', { name: 'Hide the checklist' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull());
    await waitFor(async () => expect((await settings()).checklistDismissed).toBe(true));
  });

  it('opening Settings counts as a step, and "Show again" brings tips and the checklist back', async () => {
    const user = userEvent.setup();
    renderUi(<ui.SettingsPage />);
    await waitFor(async () => expect((await settings()).seen).toContain('visited-settings'));
    await user.click(await screen.findByRole('button', { name: 'Show again' }));
    // Clearing on the Settings page counts this visit again; everything else is gone.
    await waitFor(async () => expect(await settings()).toEqual({ seen: ['visited-settings'], checklistDismissed: false }));
    cleanup();

    renderUi(<ui.GetStartedChecklist hasSource hasWatched />);
    // Everything is done now (source, settings, watched): the checklist steps aside by itself.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull());
  });

  it('a tour walks the steps once per profile; steps without their element are skipped', async () => {
    const user = userEvent.setup();
    const steps = () => [
      { target: 'one', title: 'First', body: 'The first thing.' },
      { target: 'missing', title: 'Ghost', body: 'Not on this screen.' },
      { target: 'two', title: 'Second', body: 'The second thing.' },
    ];
    const view = renderUi(
      <>
        <button type="button" data-tour="one">
          One
        </button>
        <button type="button" data-tour="two">
          Two
        </button>
        <ui.Tour id="demo" steps={steps} />
      </>,
    );
    const first = await screen.findByRole('dialog', { name: 'First' }, { timeout: 3000 });
    expect(within(first).getByText('1 of 2')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Next'); // nothing was focused: the tour takes it
    await user.click(within(first).getByRole('button', { name: 'Next' }));
    const second = await screen.findByRole('dialog', { name: 'Second' });
    expect(within(second).getByText('2 of 2')).toBeTruthy();
    await user.click(within(second).getByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(async () => expect((await settings()).seen).toContain('tour-demo'));

    // Seen: not again, even on a fresh render.
    view.unmount();
    renderUi(
      <>
        <button type="button" data-tour="one">
          One
        </button>
        <ui.Tour id="demo" steps={steps} />
      </>,
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape skips a tour (and it counts as seen); it never takes focus from a field in use', async () => {
    const user = userEvent.setup();
    renderUi(
      <>
        <input aria-label="Search" data-tour="field" />
        <ui.Tour id="escape" steps={() => [{ target: 'field', title: 'Search here', body: 'Type a name.' }]} />
      </>,
    );
    await user.click(screen.getByLabelText('Search'));
    await screen.findByRole('dialog', { name: 'Search here' }, { timeout: 3000 });
    expect(document.activeElement).toBe(screen.getByLabelText('Search'));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(async () => expect((await settings()).seen).toContain('tour-escape'));
  });
});

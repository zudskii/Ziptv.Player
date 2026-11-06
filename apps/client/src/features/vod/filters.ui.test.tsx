// @vitest-environment jsdom
import '../../test/ui-env';

import type { AuthSessionDto, SourceDto } from '@ziptv/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { hasBackend, startBackend, type Backend } from '../../test/backend';

/** Imported only after the backend is up: config.ts reads the API address when it loads. */
async function loadUi() {
  return {
    ...(await import('../../pages/vod/VodBrowsePage')),
    ...(await import('../session/session')),
    ...(await import('../profiles/profile-store')),
    ...(await import('../../lib/query-client')),
  };
}

const PLAYLIST = [
  '#EXTM3U',
  '#EXTINF:5400 group-title="EN | Action Movies",Heist (1999)',
  'http://example.com/1.mp4',
  '#EXTINF:7800 group-title="EN | Action Movies",Chase (2004)',
  'http://example.com/2.mp4',
  '#EXTINF:6000 group-title="Комедии",Laughs (2015)',
  'http://example.com/3.mp4',
].join('\n');

describe.skipIf(!hasBackend)('Movie filters against the real server', () => {
  let backend: Backend;
  let ui: Awaited<ReturnType<typeof loadUi>>;
  let source: SourceDto;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    backend = await startBackend();
    ui = await loadUi();
    ui.installSessionAuth();
    ui.installProfileHeaders();
    const response = await realFetch(`${backend.url}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'filters@example.com', password: 'correct horse battery' }) });
    const token = ((await response.json()) as AuthSessionDto).token;
    ui.useSessionStore.setState({ token, account: { email: 'filters@example.com' } });
    const boundary = '----ziptvtest';
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="movies.m3u"\r\nContent-Type: audio/x-mpegurl\r\n\r\n${PLAYLIST}\r\n--${boundary}--\r\n`);
    source = (await (await realFetch(`${backend.url}/api/v1/sources/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, body })).json()) as SourceDto;
  });
  afterAll(async () => {
    await backend?.close();
  });
  afterEach(() => {
    cleanup();
    ui.queryClient.clear();
  });

  function Where() {
    const location = useLocation();
    return <p data-testid="where">{location.search}</p>;
  }
  const renderAt = (url: string) =>
    render(
      <QueryClientProvider client={ui.queryClient}>
        <MemoryRouter initialEntries={[url]}>
          <Where />
          <Routes>
            <Route path="/movies/:sourceId?" element={<ui.VodBrowsePage kind="movies" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('picks a genre from the panel (with counts), keeps it in the URL and clears it', async () => {
    const user = userEvent.setup();
    renderAt(`/movies/${source.id}`);
    await user.click(await screen.findByRole('button', { name: 'Filters' }));
    const panel = await screen.findByRole('region', { name: 'Filters' });
    const action = await within(panel).findByRole('button', { name: /Action\s*2/ });
    expect(within(panel).getByRole('button', { name: /Comedy\s*1/ })).toBeTruthy();
    await user.click(action);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?genres=action'));
    const results = await screen.findByRole('region', { name: 'Results' });
    await waitFor(() => expect(within(results).queryByText('Laughs')).toBeNull());
    expect(within(results).getByText('Heist')).toBeTruthy();
    expect(within(results).getByText('Chase')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filters · 1' }).getAttribute('aria-expanded')).toBe('true');

    await user.click(within(panel).getByRole('button', { name: /Over 2 hours/ }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Results' })).queryByText('Heist')).toBeNull());
    expect(screen.getByTestId('where').textContent).toContain('length=long');

    await user.click(screen.getByRole('button', { name: 'Remove filter: Action' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?length=long'));
    await user.click(screen.getAllByRole('button', { name: 'Clear all' })[0]!);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(''));
  });

  it('opens a shared link already filtered, and says so when nothing matches', async () => {
    renderAt(`/movies/${source.id}?decade=1990`);
    const results = await screen.findByRole('region', { name: 'Results' });
    await waitFor(() => expect(within(results).getByText('Heist')).toBeTruthy());
    expect(within(results).queryByText('Chase')).toBeNull();
    cleanup();
    ui.queryClient.clear();

    renderAt(`/movies/${source.id}?decade=1950`);
    expect(await screen.findByText('Nothing matches these filters')).toBeTruthy();
  });
});

// @vitest-environment jsdom
import '../../test/ui-env';

import type { PlaylistDto, PlaylistEntryPageDto, SessionDto, SourceDto } from '@ziptv/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hasBackend, startBackend, type Backend } from '../../test/backend';

const SOURCE_FILE = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="euro.1" group-title="News" tvg-logo="http://logo.example/e.png",Euronews',
  'http://example.com/euronews.m3u8',
  '#EXTINF:-1 group-title="News",CNN',
  'http://example.com/cnn.m3u8',
  '#EXTINF:-1 group-title="Sport",Eurosport',
  'http://example.com/eurosport.m3u8',
  '#EXTINF:-1,Local TV',
  'http://example.com/local.m3u8',
  '',
].join('\n');

/** Imported only after the backend is up: config.ts reads the API address when it loads. */
async function loadUi() {
  return {
    ...(await import('../../pages/playlists/PlaylistsPage')),
    ...(await import('../../pages/playlists/PlaylistEditorPage')),
    ...(await import('../session/session')),
    ...(await import('../../lib/query-client')),
  };
}

describe.skipIf(!hasBackend)('Playlist screens against the real server', () => {
  let backend: Backend;
  let ui: Awaited<ReturnType<typeof loadUi>>;
  let token = '';
  let counter = 0;
  const ip = () => `10.2.${(++counter >> 8) & 255}.${counter & 255}`;

  beforeAll(async () => {
    backend = await startBackend();
    ui = await loadUi();
    ui.installSessionAuth();
  });
  afterAll(async () => backend.close());
  beforeEach(async () => {
    localStorage.clear();
    ui.queryClient.clear();
    token = ((await call<SessionDto>('/sessions', null, { method: 'POST', body: {} })).body).token;
    ui.useSessionStore.setState({ token, account: null });
  });
  afterEach(() => cleanup());

  // --- server-side helpers (what a person would have done earlier / elsewhere) ------------------

  async function call<T>(path: string, auth: string | null, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
    const response = await fetch(`${backend.url}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: response.status, body: (response.status === 204 ? null : await response.json()) as T };
  }
  const upload = async (text = SOURCE_FILE, path = '/sources/upload'): Promise<SourceDto> => {
    const boundary = '----ziptvtest';
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="list.m3u"\r\nContent-Type: audio/x-mpegurl\r\n\r\n${text}\r\n--${boundary}--\r\n`);
    const response = await fetch(`${backend.url}/api/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': ip(), 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
    return (await response.json()) as SourceDto;
  };
  const makePlaylist = async (name = 'Family') => (await call<PlaylistDto>('/playlists', token, { method: 'POST', body: { name } })).body;
  const addAll = (playlistId: string, sourceId: string) =>
    call(`/playlists/${playlistId}/entries/from-source`, token, { method: 'POST', body: { sourceId, select: { type: 'all' }, placement: { type: 'sourceGroups' } } });
  const detail = async (id: string) => (await call<PlaylistDto>(`/playlists/${id}`, token)).body;
  const entries = async (id: string) => (await call<PlaylistEntryPageDto>(`/playlists/${id}/entries?limit=100`, token)).body.items;
  const download = async (url: string) => (await fetch(`${backend.url}${new URL(url).pathname}`, { headers: { 'x-forwarded-for': ip() } })).text();
  /** A ready playlist with all four channels from a fresh source. */
  async function seeded() {
    const source = await upload();
    const playlist = await makePlaylist();
    await addAll(playlist.id, source.id);
    return { source, playlist };
  }

  // --- rendering ------------------------------------------------------------------------------

  function Where() {
    const location = useLocation();
    return <p data-testid="where">{location.pathname}</p>;
  }
  function renderApp(path: string) {
    const { PlaylistsPage, PlaylistEditorPage, queryClient } = ui;
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/playlists" element={<PlaylistsPage />} />
            <Route path="/playlists/:playlistId" element={<PlaylistEditorPage />} />
            <Route path="/sources" element={<p>Sources page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }
  const rowNames = () => screen.getAllByRole('listitem').map((row) => row.querySelector('span.truncate')?.textContent ?? '');
  const waitForRows = async (expected: string[]) => waitFor(() => expect(rowNames()).toEqual(expected));
  /** The topmost open dialog. Dialogs open and close asynchronously, so it is awaited. */
  const topDialog = async () => (await screen.findAllByRole('dialog')).at(-1)!;
  /** A modal blocks the page in a browser; here the test has to wait for it to be gone before the next step. */
  const dialogsClosed = () => waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0));

  /** A stand-in for the browser's DataTransfer: one object shared by the events of a drag. */
  function dragSession() {
    const data: Record<string, string> = {};
    return {
      get types() {
        return Object.keys(data);
      },
      setData: (type: string, value: string) => void (data[type] = value),
      getData: (type: string) => data[type] ?? '',
      effectAllowed: 'all',
      dropEffect: 'none',
    };
  }

  // --- the list of playlists ------------------------------------------------------------------

  it('creates a playlist from the empty list and opens it', async () => {
    const user = userEvent.setup();
    renderApp('/playlists');
    expect(await screen.findByText('No playlists yet')).toBeTruthy();

    await user.click(screen.getAllByRole('button', { name: 'New playlist' })[0]!);
    await user.type(within(await topDialog()).getByLabelText('Name'), 'Family');
    await user.click(within(await topDialog()).getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('This playlist is empty')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toMatch(/^\/playlists\/[0-9a-f-]{36}$/);
    expect((await call<{ name: string }[]>('/playlists', token)).body.map((p) => p.name)).toEqual(['Family']);
  });

  it('lists playlists with their counts and deletes one after confirmation', async () => {
    const { playlist } = await seeded();
    const user = userEvent.setup();
    renderApp('/playlists');
    expect(await screen.findByText('Family')).toBeTruthy();
    expect(screen.getByText('4 channels · 2 groups')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Delete Family' }));
    expect(within(await topDialog()).getByText(/link stops working/)).toBeTruthy();
    await user.click(within(await topDialog()).getByRole('button', { name: 'Delete playlist' }));
    expect(await screen.findByText('No playlists yet')).toBeTruthy();
    expect((await call(`/playlists/${playlist.id}`, token)).status).toBe(404);
  });

  // --- building -------------------------------------------------------------------------------

  it('adds channels from a source: everything, keeping the source’s groups', async () => {
    await upload();
    const playlist = await makePlaylist();
    const user = userEvent.setup();
    renderApp(`/playlists/${playlist.id}`);

    await user.click(await screen.findByRole('button', { name: 'Add channels' }));
    expect(await within(await topDialog()).findByRole('radio', { name: 'Everything (4)' })).toBeTruthy();
    await user.click(within(await topDialog()).getByRole('button', { name: 'Add' }));

    await waitForRows(['Local TV', 'Euronews', 'CNN', 'Eurosport']);
    expect((await detail(playlist.id)).groups.map((g) => [g.name, g.entryCount])).toEqual([['News', 2], ['Sport', 1]]);
  });

  it('adds only chosen groups, and only searched channels', async () => {
    await upload();
    const playlist = await makePlaylist();
    const user = userEvent.setup();
    renderApp(`/playlists/${playlist.id}`);

    await user.click(await screen.findByRole('button', { name: 'Add channels' }));
    await user.click(await within(await topDialog()).findByRole('radio', { name: 'Groups' }));
    await user.click(within(await topDialog()).getByRole('checkbox', { name: /Sport/ }));
    expect(within(await topDialog()).getByText('1 channel')).toBeTruthy();
    await user.click(within(await topDialog()).getByRole('button', { name: 'Add' }));
    await waitForRows(['Eurosport']);

    await user.click(screen.getByRole('button', { name: 'Add channels' }));
    await user.click(await within(await topDialog()).findByRole('radio', { name: 'Channels' }));
    await user.type(within(await topDialog()).getByLabelText('Search channels'), 'euro');
    await user.click(await within(await topDialog()).findByRole('button', { name: 'Select 2' }));
    await user.click(within(await topDialog()).getByRole('button', { name: 'Add' }));
    await waitFor(async () => expect((await entries(playlist.id)).map((e) => e.name).sort()).toEqual(['Euronews', 'Eurosport']));
  });

  it('sends the person to add a source first when there is none', async () => {
    const playlist = await makePlaylist();
    const user = userEvent.setup();
    renderApp(`/playlists/${playlist.id}`);
    await user.click(await screen.findByRole('button', { name: 'Add channels' }));
    expect(await within(await topDialog()).findByRole('link', { name: 'Add a source' })).toBeTruthy();
  });

  // --- organising -----------------------------------------------------------------------------

  it('moves selected channels into a group created on the spot', async () => {
    const { playlist } = await seeded();
    const user = userEvent.setup();
    renderApp(`/playlists/${playlist.id}`);
    await waitForRows(['Local TV', 'Euronews', 'CNN', 'Eurosport']);

    await user.click(screen.getByRole('checkbox', { name: 'Select CNN' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Eurosport' }));
    expect(screen.getByText('2 selected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Move to…' }));
    await user.click(within(await topDialog()).getByRole('radio', { name: 'New group…' }));
    await user.type(within(await topDialog()).getByLabelText('New group name'), 'Favorites');
    await user.click(within(await topDialog()).getByRole('button', { name: 'Move' }));

    await waitFor(async () => expect((await detail(playlist.id)).groups.map((g) => [g.name, g.entryCount])).toEqual([['News', 1], ['Sport', 0], ['Favorites', 2]]));
    expect(await screen.findByRole('button', { name: /^Favorites/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull()); // the selection is spent once the move is done
  });

  it('shows one group at a time and searches inside the playlist', async () => {
    const { playlist } = await seeded();
    const user = userEvent.setup();
    renderApp(`/playlists/${playlist.id}`);
    await waitForRows(['Local TV', 'Euronews', 'CNN', 'Eurosport']);

    await user.click(screen.getByRole('button', { name: /^News/ }));
    await waitForRows(['Euronews', 'CNN']);
    await user.click(screen.getByRole('button', { name: /^No group/ }));
    await waitForRows(['Local TV']);
    await user.click(screen.getByRole('button', { name: /^All channels/ }));
    await user.type(screen.getByLabelText('Search in this playlist'), 'euro');
    await waitForRows(['Euronews', 'Eurosport']);
    await user.clear(screen.getByLabelText('Search in this playlist'));
    await user.type(screen.getByLabelText('Search in this playlist'), 'zzz');
    expect(await screen.findByText('No channels here')).toBeTruthy();
  });

  it('regroups by dragging channels onto a group, and reorders by dropping onto a row', async () => {
    const { playlist } = await seeded();
    renderApp(`/playlists/${playlist.id}`);
    await waitForRows(['Local TV', 'Euronews', 'CNN', 'Eurosport']);
    const rowOf = (name: string) => screen.getByRole('checkbox', { name: `Select ${name}` }).closest('[draggable="true"]') as HTMLElement;

    // Drop "Local TV" on the group "Sport".
    let dataTransfer = dragSession();
    fireEvent.dragStart(rowOf('Local TV'), { dataTransfer });
    const sport = screen.getByRole('button', { name: /^Sport/ }).parentElement!;
    fireEvent.dragOver(sport, { dataTransfer });
    fireEvent.drop(sport, { dataTransfer });
    await waitFor(async () => expect((await detail(playlist.id)).groups.find((g) => g.name === 'Sport')?.entryCount).toBe(2));
    // The person sees the result before the next drag; so does the test (a stale row would still point at the old group).
    await waitFor(() => expect(within(rowOf('Local TV')).getByText(/^Sport · /)).toBeTruthy());

    // Dropping "Euronews" on "Local TV" moves it into Sport, in front of it.
    dataTransfer = dragSession();
    fireEvent.dragStart(rowOf('Euronews'), { dataTransfer });
    fireEvent.dragOver(rowOf('Local TV'), { dataTransfer });
    fireEvent.drop(rowOf('Local TV'), { dataTransfer });
    await waitFor(async () => {
      const sportId = (await detail(playlist.id)).groups.find((g) => g.name === 'Sport')!.id;
      expect((await entries(playlist.id)).filter((e) => e.groupId === sportId).map((e) => e.name)).toEqual(['Eurosport', 'Euronews', 'Local TV']);
    });
  });

  it('ignores drags that carry something other than channels', async () => {
    const { playlist } = await seeded();
    renderApp(`/playlists/${playlist.id}`);
    await waitForRows(['Local TV', 'Euronews', 'CNN', 'Eurosport']);
    const sport = screen.getByRole('button', { name: /^Sport/ }).parentElement!;
    const foreign = { types: ['Files'], getData: () => '', setData: () => undefined, dropEffect: 'none', effectAllowed: 'all' };
    fireEvent.dragOver(sport, { dataTransfer: foreign });
    fireEvent.drop(sport, { dataTransfer: foreign });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await detail(playlist.id)).groups.find((g) => g.name === 'Sport')?.entryCount).toBe(1);
  });

  it('manages groups: create, rename (case-insensitive duplicates refused), reorder, delete', async () => {
    const { playlist } = await seeded();
    const user = userEvent.setup();
    renderApp(`/playlists/${playlist.id}`);
    await waitForRows(['Local TV', 'Euronews', 'CNN', 'Eurosport']);

    await user.click(screen.getByRole('button', { name: 'New group' }));
    await user.type(within(await topDialog()).getByLabelText('Group name'), 'sport'); // exists as "Sport"
    await user.click(within(await topDialog()).getByRole('button', { name: 'Create' }));
    expect(await within(await topDialog()).findByText(/already exists/)).toBeTruthy();
    await user.clear(within(await topDialog()).getByLabelText('Group name'));
    await user.type(within(await topDialog()).getByLabelText('Group name'), 'Kids');
    await user.click(within(await topDialog()).getByRole('button', { name: 'Create' }));
    await screen.findByRole('button', { name: /^Kids/ });

    await user.click(screen.getByRole('button', { name: 'Options for Kids' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }));
    await waitFor(async () => expect((await detail(playlist.id)).groups.map((g) => g.name)).toEqual(['News', 'Kids', 'Sport']));

    await user.click(screen.getByRole('button', { name: 'Options for News' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete group…' }));
    await user.click(within(await topDialog()).getByRole('button', { name: 'Delete group' }));
    await waitFor(async () => expect((await detail(playlist.id)).ungroupedCount).toBe(3)); // its channels stayed
    expect((await detail(playlist.id)).groups.map((g) => g.name)).toEqual(['Kids', 'Sport']);
  });

  // --- editing --------------------------------------------------------------------------------

  it('edits a channel’s name and number, refuses bad input, and removes a channel', async () => {
    const { playlist } = await seeded();
    const user = userEvent.setup();
    renderApp(`/playlists/${playlist.id}`);
    await waitForRows(['Local TV', 'Euronews', 'CNN', 'Eurosport']);

    await user.click(screen.getByRole('button', { name: 'Edit Local TV' }));
    await user.clear(within(await topDialog()).getByLabelText('Name'));
    await user.type(within(await topDialog()).getByLabelText('Name'), 'My Local');
    await user.type(within(await topDialog()).getByLabelText('Channel number'), '0');
    await user.click(within(await topDialog()).getByRole('button', { name: 'Save' }));
    expect(await within(await topDialog()).findByText(/whole number from 1 to 99,999/)).toBeTruthy();
    await user.clear(within(await topDialog()).getByLabelText('Channel number'));
    await user.type(within(await topDialog()).getByLabelText('Channel number'), '99');
    await user.click(within(await topDialog()).getByRole('button', { name: 'Save' }));
    await waitForRows(['My Local', 'Euronews', 'CNN', 'Eurosport']);
    expect(await screen.findByText('#99')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove CNN' }));
    await user.click(within(await topDialog()).getByRole('button', { name: 'Remove' }));
    await waitForRows(['My Local', 'Euronews', 'Eurosport']);
    expect((await detail(playlist.id)).entryCount).toBe(3);
  });

  it('numbers all channels in display order', async () => {
    const { playlist } = await seeded();
    const user = userEvent.setup();
    renderApp(`/playlists/${playlist.id}`);
    await waitForRows(['Local TV', 'Euronews', 'CNN', 'Eurosport']);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Number channels…' }));
    const dialog = await topDialog();
    await user.clear(within(dialog).getByLabelText('Start at'));
    await user.type(within(dialog).getByLabelText('Start at'), '100');
    await user.clear(within(dialog).getByLabelText('Step'));
    await user.type(within(dialog).getByLabelText('Step'), '10');
    expect(within(dialog).getByText(/numbers 100 to 130/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Number channels' }));
    await waitFor(async () => expect((await entries(playlist.id)).map((e) => [e.name, e.number])).toEqual([['Local TV', 100], ['Euronews', 110], ['CNN', 120], ['Eurosport', 130]]));
  });

  // --- the link -------------------------------------------------------------------------------

  it('creates the link, shows it, serves the edited playlist at it, and turns it off', async () => {
    const { playlist } = await seeded();
    const user = userEvent.setup();
    renderApp(`/playlists/${playlist.id}`);
    await waitForRows(['Local TV', 'Euronews', 'CNN', 'Eurosport']);

    await user.click(screen.getByRole('button', { name: 'Edit CNN' }));
    await user.clear(within(await topDialog()).getByLabelText('Name'));
    await user.type(within(await topDialog()).getByLabelText('Name'), 'CNN International');
    await user.click(within(await topDialog()).getByRole('button', { name: 'Save' }));
    await waitForRows(['Local TV', 'Euronews', 'CNN International', 'Eurosport']);
    await dialogsClosed();

    await user.click(screen.getByRole('button', { name: /^Link/ }));
    await user.click(await within(await topDialog()).findByRole('button', { name: 'Create link' }));
    const field = (await within(await topDialog()).findByLabelText('M3U link')) as HTMLInputElement;
    const original = field.value; // the input element is reused when the link changes, so keep the string
    expect(original).toMatch(/\/p\/[A-Za-z0-9_-]{43}\.m3u$/);
    expect(within(await topDialog()).getByText(/Treat this link like a password/)).toBeTruthy();

    const text = await download(original);
    expect(text.startsWith('#EXTM3U\n')).toBe(true);
    expect(text).toContain('group-title="News",CNN International\nhttp://example.com/cnn.m3u8');
    expect(text).toContain('#EXTINF:-1,Local TV\nhttp://example.com/local.m3u8');

    // Replacing the link asks for confirmation inside this dialog; the dialog must stay open and show the new link.
    await user.click(within(await topDialog()).getByRole('button', { name: 'Create a new link' }));
    await user.click(within((await screen.findAllByRole('dialog')).at(-1)!).getByRole('button', { name: 'Replace link' }));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    await waitFor(() => expect((within(screen.getAllByRole('dialog')[0]!).getByLabelText('M3U link') as HTMLInputElement).value).not.toBe(original));
    const replaced = (within(screen.getAllByRole('dialog')[0]!).getByLabelText('M3U link') as HTMLInputElement).value;
    expect(await download(replaced)).toContain('CNN International');
    expect((await fetch(`${backend.url}${new URL(original).pathname}`, { headers: { 'x-forwarded-for': ip() } })).status).toBe(404); // the old link died

    await user.click(within(await topDialog()).getByRole('button', { name: 'Turn off link' }));
    const confirm = screen.getAllByRole('dialog').at(-1)!;
    await user.click(within(confirm).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1)); // the confirmation closed
    expect(await within(await topDialog()).findByRole('button', { name: 'Create link' })).toBeTruthy();
    expect((await fetch(`${backend.url}${new URL(replaced).pathname}`, { headers: { 'x-forwarded-for': ip() } })).status).toBe(404);
  });

  // --- when the provider changes things -------------------------------------------------------

  it('flags channels that vanished from the source, reconnects re-grouped ones and removes the rest', async () => {
    const { source, playlist } = await seeded();
    // The provider drops CNN and moves Euronews to another group (which changes its key).
    await upload(
      ['#EXTM3U', '#EXTINF:-1 group-title="International",Euronews', 'http://example.com/euronews.m3u8', '#EXTINF:-1 group-title="Sport",Eurosport', 'http://example.com/eurosport.m3u8', '#EXTINF:-1,Local TV', 'http://example.com/local.m3u8', ''].join('\n'),
      `/sources/${source.id}/file`,
    );
    const user = userEvent.setup();
    renderApp(`/playlists/${playlist.id}`);
    await waitForRows(['Local TV', 'Euronews', 'CNN', 'Eurosport']);

    // The server already re-attached Euronews after the sync; only CNN is gone.
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/1 channel is no longer in its source/);
    expect(within(screen.getByRole('checkbox', { name: 'Select CNN' }).closest('[draggable]') as HTMLElement).getByText('Missing')).toBeTruthy();

    await user.click(within(banner).getByRole('button', { name: 'Show them' }));
    await waitForRows(['CNN']);
    await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Remove' }));
    await user.click(within(await topDialog()).getByRole('button', { name: 'Remove them' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    await waitForRows(['Local TV', 'Euronews', 'Eurosport']);
    expect((await detail(playlist.id)).missingCount).toBe(0);
  });

  it('explains a playlist that does not exist', async () => {
    renderApp('/playlists/0192f7d0-0000-7000-8000-000000000000');
    expect(await screen.findByText('Playlist not found')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All playlists' })).toBeTruthy();
  });
});

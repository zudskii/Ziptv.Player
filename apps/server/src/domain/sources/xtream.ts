/**
 * Xtream Codes URL layout (pure). The panel exposes:
 *   player_api.php?username&password[&action=…]   — JSON catalog API
 *   xmltv.php?username&password                    — programme guide
 *   get.php?username&password&type=m3u_plus         — the same catalog as an M3U
 *   /live|movie|series/{user}/{pass}/{id}.{ext}     — streams
 *   /timeshift/{user}/{pass}/{minutes}/{YYYY-MM-DD:HH-MM}/{id}.ts — archive (catch-up)
 *
 * Credentials sit in the path or query of every URL: they are built server-side only, stored
 * encrypted, and reach clients only inside encrypted proxy tokens (or directly in `auto`
 * delivery, where the account is the user's own).
 */

export interface XtreamAccount {
  server: string;
  username: string;
  password: string;
}

export type XtreamStreamType = 'live' | 'movie' | 'series';

function base(server: string): string {
  return server.endsWith('/') ? server : `${server}/`;
}

const segment = (value: string) => encodeURIComponent(value);

export function xtreamApiUrl(account: XtreamAccount, params: Record<string, string> = {}): string {
  const url = new URL('player_api.php', base(account.server));
  url.searchParams.set('username', account.username);
  url.searchParams.set('password', account.password);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.href;
}

export function xtreamXmltvUrl(account: XtreamAccount): string {
  const url = new URL('xmltv.php', base(account.server));
  url.searchParams.set('username', account.username);
  url.searchParams.set('password', account.password);
  return url.href;
}

export function xtreamStreamUrl(account: XtreamAccount, type: XtreamStreamType, id: number, extension: string): string {
  const ext = extension.replace(/^\./, '').toLowerCase() || (type === 'live' ? 'ts' : 'mp4');
  return new URL(`${type}/${segment(account.username)}/${segment(account.password)}/${id}.${segment(ext)}`, base(account.server)).href;
}

/**
 * Archive URL. Panels interpret the start time in *their* timezone (server_info.timezone), so the
 * caller passes that zone's UTC offset (minutes) at the programme's start.
 */
export function xtreamTimeshiftUrl(account: XtreamAccount, id: number, start: Date, durationMinutes: number, serverOffsetMinutes = 0): string {
  const local = new Date(start.getTime() + serverOffsetMinutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}:${pad(local.getUTCHours())}-${pad(local.getUTCMinutes())}`;
  const minutes = Math.max(1, Math.ceil(durationMinutes));
  return new URL(`timeshift/${segment(account.username)}/${segment(account.password)}/${minutes}/${stamp}/${id}.ts`, base(account.server)).href;
}

/** Live format: HLS when the account allows it (plays everywhere through the proxy), else MPEG-TS. */
export function preferredLiveExtension(allowedFormats: readonly string[]): 'm3u8' | 'ts' {
  const allowed = allowedFormats.map((format) => format.toLowerCase());
  if (allowed.length === 0 || allowed.includes('m3u8')) return 'm3u8';
  return 'ts';
}

/** The Xtream account behind an M3U link `…/get.php?username=…&password=…`, or null. */
export function parseXtreamPlaylistUrl(input: string | URL): XtreamAccount | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!/\/get\.php$/i.test(url.pathname)) return null;
  const username = url.searchParams.get('username');
  const password = url.searchParams.get('password');
  if (!username || !password) return null;
  const server = new URL(url.href);
  server.search = '';
  server.hash = '';
  server.username = '';
  server.password = '';
  server.pathname = server.pathname.replace(/\/get\.php$/i, '/');
  return { server: server.href, username, password };
}

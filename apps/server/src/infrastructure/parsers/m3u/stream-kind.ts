import type { StreamKind } from './types.js';

const EXTENSION_KINDS: Record<string, StreamKind> = {
  m3u8: 'hls',
  m3u: 'hls',
  mpd: 'dash',
  ts: 'mpegts',
  mts: 'mpegts',
  m2ts: 'mpegts',
  mpegts: 'mpegts',
  flv: 'flv',
  mp4: 'progressive',
  m4v: 'progressive',
  mov: 'progressive',
  webm: 'progressive',
  mkv: 'progressive',
  ogv: 'progressive',
  ogg: 'progressive',
  mp3: 'progressive',
  aac: 'progressive',
  m4a: 'progressive',
  opus: 'progressive',
  flac: 'progressive',
  wav: 'progressive',
};

/** Query parameters providers use to select the container (Xtream `output=ts`, `type=m3u8`, ...). */
const QUERY_HINT_KEYS = ['output', 'type', 'format', 'extension', 'ext', 'container'];

const QUERY_HINT_KINDS: Record<string, StreamKind> = {
  m3u8: 'hls',
  hls: 'hls',
  ts: 'mpegts',
  mpegts: 'mpegts',
  flv: 'flv',
  mpd: 'dash',
  dash: 'dash',
  mp4: 'progressive',
};

/**
 * Cheap, offline classification from the URL alone. `unknown` is expected for extension-less
 * URLs (e.g. Xtream `http://host:port/user/pass/1234`) — the playback layer probes those.
 */
export function detectStreamKind(url: URL): StreamKind {
  const lastSegment = url.pathname.slice(url.pathname.lastIndexOf('/') + 1).toLowerCase();
  const dot = lastSegment.lastIndexOf('.');
  if (dot !== -1) {
    const kind = EXTENSION_KINDS[lastSegment.slice(dot + 1)];
    if (kind) return kind;
  }

  for (const key of QUERY_HINT_KEYS) {
    const hint = url.searchParams.get(key)?.toLowerCase();
    const kind = hint ? QUERY_HINT_KINDS[hint] : undefined;
    if (kind) return kind;
  }

  return 'unknown';
}

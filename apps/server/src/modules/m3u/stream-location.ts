import { parseKodiHeaderString } from './stream-headers.js';
import type { StreamHeaders } from './types.js';

/** Protocols a browser can play (directly or through our HTTP proxy). */
const PLAYABLE_PROTOCOLS = new Set(['http:', 'https:']);

/** Real streaming protocols that need a transcoder/native player; kept but flagged as unplayable. */
const KNOWN_STREAMING_PROTOCOLS = new Set([
  'rtmp:',
  'rtmps:',
  'rtmpe:',
  'rtmpt:',
  'rtsp:',
  'rtsps:',
  'rtp:',
  'udp:',
  'mms:',
  'mmsh:',
  'srt:',
  'acestream:',
  'igmp:',
]);

export type StreamLocation =
  | { status: 'ok'; url: URL; headers: StreamHeaders; playable: boolean }
  | { status: 'invalid'; reason: string };

/**
 * Parses a playlist URI line into an absolute URL plus Kodi-style pipe headers.
 *
 * `http://host/live.m3u8|User-Agent=VLC&Referer=http://x` → url + { user-agent, referer }.
 * Without this split the whole string is used as the URL and the stream never opens.
 */
export function parseStreamLocation(raw: string, baseUrl?: URL): StreamLocation {
  let value = raw.trim();
  if (value.length >= 2 && isWrapped(value)) value = value.slice(1, -1).trim();
  if (!value) return { status: 'invalid', reason: 'empty URI' };

  let headers: StreamHeaders = {};
  const pipe = value.indexOf('|');
  if (pipe !== -1) {
    headers = parseKodiHeaderString(value.slice(pipe + 1));
    value = value.slice(0, pipe).trim();
  }

  const url = toAbsoluteUrl(value, baseUrl);
  if (!url) return { status: 'invalid', reason: baseUrl ? 'not a valid URL' : 'relative path in an uploaded file' };

  if (PLAYABLE_PROTOCOLS.has(url.protocol)) {
    if (!url.hostname) return { status: 'invalid', reason: 'URL has no host' };
    return { status: 'ok', url, headers, playable: true };
  }
  if (KNOWN_STREAMING_PROTOCOLS.has(url.protocol)) return { status: 'ok', url, headers, playable: false };
  return { status: 'invalid', reason: `unsupported scheme ${url.protocol}` };
}

/** Resolves a logo reference; only web images are kept (http/https/data:image). */
export function parseImageUrl(raw: string | null | undefined, baseUrl?: URL): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^data:image\//i.test(value)) return value.length <= 64 * 1024 ? value : null;
  const url = toAbsoluteUrl(value, baseUrl);
  return url && PLAYABLE_PROTOCOLS.has(url.protocol) && url.hostname ? url.href : null;
}

function toAbsoluteUrl(value: string, baseUrl?: URL): URL | null {
  if (value.startsWith('//')) value = `${baseUrl?.protocol ?? 'http:'}${value}`;
  const absolute = tryParseUrl(value);
  if (absolute) return absolute;
  if (baseUrl) return tryParseUrl(value, baseUrl);
  // Bare `host:port/path` or `www.example.com/stream.m3u8` without a scheme.
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\//i.test(value)) return tryParseUrl(`http://${value}`);
  return null;
}

/** One parse on the happy path (canParse + new URL would parse twice). */
function tryParseUrl(value: string, base?: URL): URL | null {
  // Cheap pre-check avoids throwing (slow) for obvious non-URLs such as bare file names.
  if (!base && !value.includes(':')) return null;
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function isWrapped(value: string): boolean {
  const first = value[0];
  const last = value[value.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'") || (first === '<' && last === '>');
}

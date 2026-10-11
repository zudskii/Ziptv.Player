import { safeDecodeURIComponent, sanitizeHeaderValue } from './text.js';
import type { AllowedStreamHeader, StreamHeaders } from './types.js';

/**
 * Every alias real playlists use for the few headers a browser cannot send itself.
 * Keys are lower-cased; values are the canonical header name we forward upstream.
 */
const HEADER_ALIASES: Record<string, AllowedStreamHeader> = {
  'user-agent': 'user-agent',
  'http-user-agent': 'user-agent',
  useragent: 'user-agent',
  'tvg-user-agent': 'user-agent',
  referer: 'referer',
  referrer: 'referer',
  'http-referer': 'referer',
  'http-referrer': 'referer',
  origin: 'origin',
  'http-origin': 'origin',
  cookie: 'cookie',
  'http-cookie': 'cookie',
  authorization: 'authorization',
  'http-authorization': 'authorization',
};

const ALIAS_KEYS = Object.keys(HEADER_ALIASES);

export function canonicalHeaderName(name: string): AllowedStreamHeader | null {
  return HEADER_ALIASES[name.trim().toLowerCase()] ?? null;
}

/** Adds `name: value` when the name is whitelisted and the value is safe. Later calls win. */
export function setStreamHeader(target: StreamHeaders, name: string, value: string): void {
  const canonical = canonicalHeaderName(name);
  const sanitized = sanitizeHeaderValue(value);
  if (canonical && sanitized) target[canonical] = sanitized;
}

/** Headers declared as EXTINF attributes, e.g. `user-agent="..." http-referrer="..."`. */
export function headersFromAttributes(attributes: Record<string, string>): StreamHeaders {
  const headers: StreamHeaders = {};
  // Attribute keys are already lower-cased by the parser: direct lookups, no full scan.
  for (const alias of ALIAS_KEYS) {
    const value = attributes[alias];
    if (value !== undefined) setStreamHeader(headers, alias, value);
  }
  return headers;
}

/**
 * Kodi-style header string: `User-Agent=abc&Referer=http%3A%2F%2Fx`.
 * Used both after a `|` in stream URLs and in `inputstream.adaptive.stream_headers`.
 */
export function parseKodiHeaderString(input: string): StreamHeaders {
  const headers: StreamHeaders = {};
  for (const pair of input.split('&')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = safeDecodeURIComponent(pair.slice(0, separator));
    const value = safeDecodeURIComponent(pair.slice(separator + 1));
    setStreamHeader(headers, name, value);
  }
  return headers;
}

/** `#EXTHTTP:{"User-Agent":"...","cookie":"..."}` (TiviMate / OTT Navigator). */
export function parseExtHttp(json: string): StreamHeaders | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const headers: StreamHeaders = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string') setStreamHeader(headers, name, value);
  }
  return headers;
}

export function hasHeaders(headers: StreamHeaders): boolean {
  return Object.keys(headers).length > 0;
}

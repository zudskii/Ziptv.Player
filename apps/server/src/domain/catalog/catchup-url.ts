import type { CatchupInfo } from './model.js';

/**
 * Archive (catch-up) addresses of live channels, built from the channel's stream URL and its
 * `catchup` attributes. Pure: the caller decides whether the viewer may watch the programme.
 *
 * Modes (TiviMate / Kodi IPTV Simple conventions):
 *   default   — `catchup-source` is the whole archive URL (absolute, or relative to the stream).
 *   append    — `catchup-source` is appended to the stream URL (`?utc={utc}&lutc={lutc}` if none).
 *   shift     — `utc={utc}&lutc={lutc}` is added to the stream URL's query.
 *   flussonic — the stream path is rewritten: `…/index.m3u8` → `…/index-{utc}-{duration}.m3u8`,
 *               `…/mpegts` or `…/x.ts` → `…/timeshift_abs-{utc}.ts`.
 *   xtream    — built from the account (see `xtreamTimeshiftUrl`), not here.
 *
 * Placeholders (`{…}` or `${…}`; times are Unix seconds, calendar fields UTC):
 *   {utc} {start}            programme start          {utcend} {end}         programme end
 *   {lutc} {now} {timestamp} now                      {duration}             length in seconds
 *   {duration:N}             length ÷ N (e.g. {duration:60} = minutes)
 *   {offset:N}               (now − start) ÷ N
 *   {Y} {m} {d} {H} {M} {S}  start, UTC calendar fields
 *   {utc:FMT} {utcend:FMT} {lutc:FMT} {start:FMT} {end:FMT} {now:FMT}
 *                            formatted time; FMT letters Y m d H M S, anything else is literal
 * A placeholder this module does not know (e.g. `{catchup-id}`) makes the template unusable:
 * guessing would play the wrong programme.
 */

export interface CatchupTimes {
  start: Date;
  end: Date;
  now: Date;
}

export class CatchupTemplateError extends Error {}

const DEFAULT_APPEND = '?utc={utc}&lutc={lutc}';
const PLACEHOLDER = /\$?\{([a-z][a-z-]*)(?::([^{}]*))?\}/gi;

/** The archive URL of the programme, or null when the mode needs provider data (xtream). */
export function buildCatchupUrl(info: CatchupInfo, streamUrl: string, times: CatchupTimes): string | null {
  switch (info.mode) {
    case 'xtream':
      return null;
    case 'default': {
      if (!info.template) return appendQuery(streamUrl, expand(DEFAULT_APPEND, times));
      return new URL(expand(info.template, times), streamUrl).href;
    }
    case 'append':
      return appendQuery(streamUrl, expand(info.template ?? DEFAULT_APPEND, times));
    case 'shift':
      return appendQuery(streamUrl, expand(DEFAULT_APPEND, times));
    case 'flussonic':
      if (info.template) return new URL(expand(info.template, times), streamUrl).href;
      return flussonicUrl(streamUrl, times);
  }
}

/** Substitutes the placeholders of a template. Throws CatchupTemplateError for unknown ones. */
export function expand(template: string, times: CatchupTimes): string {
  const start = seconds(times.start);
  const end = seconds(times.end);
  const now = seconds(times.now);
  const duration = Math.max(0, end - start);
  return template.replace(PLACEHOLDER, (match, rawName: string, argument: string | undefined) => {
    const name = rawName.toLowerCase();
    const instant = INSTANTS[name];
    if (instant) {
      const value = instant === 'start' ? times.start : instant === 'end' ? times.end : times.now;
      return argument === undefined ? String(seconds(value)) : formatUtc(value, argument);
    }
    if (argument === undefined && /^[YmdHMS]$/.test(rawName)) return formatUtc(times.start, rawName);
    if (name === 'duration') return String(argument === undefined ? duration : divide(duration, argument, match));
    if (name === 'offset') return String(divide(Math.max(0, now - start), argument ?? '1', match));
    throw new CatchupTemplateError(`Unsupported catch-up placeholder ${match}.`);
  });
}

const INSTANTS: Record<string, 'start' | 'end' | 'now'> = {
  utc: 'start',
  start: 'start',
  utcend: 'end',
  end: 'end',
  lutc: 'now',
  now: 'now',
  timestamp: 'now',
};

function divide(value: number, argument: string, match: string): number {
  const divisor = Number(argument);
  if (!Number.isInteger(divisor) || divisor <= 0) throw new CatchupTemplateError(`Unsupported catch-up placeholder ${match}.`);
  return Math.floor(value / divisor);
}

function formatUtc(date: Date, format: string): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  const fields: Record<string, string> = {
    Y: pad(date.getUTCFullYear(), 4),
    m: pad(date.getUTCMonth() + 1),
    d: pad(date.getUTCDate()),
    H: pad(date.getUTCHours()),
    M: pad(date.getUTCMinutes()),
    S: pad(date.getUTCSeconds()),
  };
  return [...format].map((char) => fields[char] ?? char).join('');
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** Adds `?a=b&c=d` (or `&a=b…`) to a URL, keeping its own query and fragment-free form. */
function appendQuery(streamUrl: string, suffix: string): string {
  const url = new URL(streamUrl);
  if (!/^[?&]/.test(suffix)) return `${streamUrl}${suffix}`;
  const params = new URLSearchParams(suffix.slice(1));
  for (const [name, value] of params) url.searchParams.set(name, value);
  return url.href;
}

function flussonicUrl(streamUrl: string, times: CatchupTimes): string | null {
  const url = new URL(streamUrl);
  const parts = url.pathname.split('/');
  const last = parts.at(-1) ?? '';
  const start = seconds(times.start);
  const duration = Math.max(1, seconds(times.end) - start);
  const hls = /^(.+)\.m3u8$/i.exec(last);
  if (hls) {
    parts[parts.length - 1] = `${hls[1]}-${start}-${duration}.m3u8`;
  } else if (last === 'mpegts' || /\.ts$/i.test(last)) {
    parts[parts.length - 1] = `timeshift_abs-${start}.ts`;
  } else {
    return null;
  }
  url.pathname = parts.join('/');
  return url.href;
}

// --- who may watch which programme ---------------------------------------------------------------

export const MAX_CATCHUP_PROGRAMME_MS = 12 * 3_600_000;

export type CatchupProblem = 'not_available' | 'invalid_range' | 'not_ended' | 'outside_window' | 'too_long';

/**
 * Whether [start, end) can be replayed from an archive kept `days` days: it must have ended,
 * started inside the window, and be one programme long (at most 12 h). `notBefore` narrows the
 * window further (e.g. the licence of an operator channel began later).
 */
export function catchupProblem(days: number | null | undefined, range: { start: Date; end: Date }, now: Date, notBefore?: Date | null): CatchupProblem | null {
  if (!days || days <= 0) return 'not_available';
  const start = range.start.getTime();
  const end = range.end.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'invalid_range';
  if (end - start > MAX_CATCHUP_PROGRAMME_MS) return 'too_long';
  if (end > now.getTime()) return 'not_ended';
  const earliest = Math.max(now.getTime() - days * 86_400_000, notBefore?.getTime() ?? -Infinity);
  if (start < earliest) return 'outside_window';
  return null;
}

/** UTC offset (minutes) of an IANA zone at an instant; 0 for unknown zones. */
export function zoneOffsetMinutes(timeZone: string | null | undefined, at: Date): number {
  if (!timeZone) return 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at);
    const field = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const local = Date.UTC(field('year'), field('month') - 1, field('day'), field('hour'), field('minute'), field('second'));
    return Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  } catch {
    return 0;
  }
}

/** A valid IANA zone name or null. */
export function validTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

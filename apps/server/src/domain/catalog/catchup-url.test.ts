import { describe, expect, it } from 'vitest';

import { buildCatchupUrl, catchupProblem, CatchupTemplateError, expand, validTimeZone, zoneOffsetMinutes } from './catchup-url.js';

const start = new Date('2026-10-20T18:00:00Z'); // 1792519200
const end = new Date('2026-10-20T19:30:00Z'); // +5400 s
const now = new Date('2026-10-21T08:00:00Z'); // 1792569600
const times = { start, end, now };
const S = start.getTime() / 1000;
const E = end.getTime() / 1000;
const N = now.getTime() / 1000;

describe('catch-up templates', () => {
  it('expands the Kodi / TiviMate placeholders (both {x} and ${x})', () => {
    expect(expand('{utc}|${start}|{utcend}|${end}|{lutc}|${now}|${timestamp}', times)).toBe(`${S}|${S}|${E}|${E}|${N}|${N}|${N}`);
    expect(expand('{duration}|${duration}|{duration:60}|{offset:1}|{offset:60}', times)).toBe(`5400|5400|90|${N - S}|${Math.floor((N - S) / 60)}`);
    expect(expand('{Y}-{m}-{d}T{H}:{M}:{S}', times)).toBe('2026-10-20T18:00:00');
    expect(expand('{utc:Y-m-d:H-M}/{utcend:YmdHMS}/{lutc:Ymd}', times)).toBe('2026-10-20:18-00/20261020193000/20261021');
  });

  it('refuses placeholders it cannot fill instead of guessing', () => {
    expect(() => expand('/archive/{catchup-id}.m3u8', times)).toThrow(CatchupTemplateError);
    expect(() => expand('{duration:0}', times)).toThrow(CatchupTemplateError);
  });

  it('default: the template is the archive URL, relative ones resolve against the stream', () => {
    expect(buildCatchupUrl({ mode: 'default', days: 3, template: 'http://arc.example/{utc}/{duration}.m3u8' }, 'http://live.example/ch1.m3u8', times)).toBe(
      `http://arc.example/${S}/5400.m3u8`,
    );
    expect(buildCatchupUrl({ mode: 'default', days: 3, template: 'archive/{utc:YmdHMS}.ts' }, 'http://live.example/tv/ch1.ts', times)).toBe('http://live.example/tv/archive/20261020180000.ts');
  });

  it('append and shift add to the stream query without breaking an existing one', () => {
    expect(buildCatchupUrl({ mode: 'shift', days: 1, template: null }, 'http://live.example/ch.m3u8?token=a', times)).toBe(`http://live.example/ch.m3u8?token=a&utc=${S}&lutc=${N}`);
    expect(buildCatchupUrl({ mode: 'append', days: 1, template: '?start={utc}&dur={duration}' }, 'http://live.example/ch.m3u8?token=a', times)).toBe(
      `http://live.example/ch.m3u8?token=a&start=${S}&dur=5400`,
    );
    expect(buildCatchupUrl({ mode: 'append', days: 1, template: '/{utc}.m3u8' }, 'http://live.example/ch', times)).toBe(`http://live.example/ch/${S}.m3u8`);
  });

  it('flussonic rewrites the stream path (HLS and MPEG-TS) and keeps the token', () => {
    expect(buildCatchupUrl({ mode: 'flussonic', days: 1, template: null }, 'http://fl.example/ch1/index.m3u8?token=t', times)).toBe(`http://fl.example/ch1/index-${S}-5400.m3u8?token=t`);
    expect(buildCatchupUrl({ mode: 'flussonic', days: 1, template: null }, 'http://fl.example/ch1/mpegts?token=t', times)).toBe(`http://fl.example/ch1/timeshift_abs-${S}.ts?token=t`);
    expect(buildCatchupUrl({ mode: 'flussonic', days: 1, template: null }, 'http://fl.example/ch1/', times)).toBeNull();
  });

  it('xtream archives need the account (built elsewhere)', () => {
    expect(buildCatchupUrl({ mode: 'xtream', days: 3, template: null }, 'http://x.example/live/u/p/1.ts', times)).toBeNull();
  });
});

describe('catch-up window', () => {
  it('only ended programmes inside the archive window, at most 12 hours long', () => {
    expect(catchupProblem(1, { start, end }, now)).toBeNull();
    expect(catchupProblem(null, { start, end }, now)).toBe('not_available');
    expect(catchupProblem(0, { start, end }, now)).toBe('not_available');
    expect(catchupProblem(1, { start: end, end: start }, now)).toBe('invalid_range');
    expect(catchupProblem(1, { start: new Date(now.getTime() - 3_600_000), end: new Date(now.getTime() + 60_000) }, now)).toBe('not_ended');
    expect(catchupProblem(1, { start: new Date(now.getTime() - 25 * 3_600_000), end: new Date(now.getTime() - 24 * 3_600_000) }, now)).toBe('outside_window');
    expect(catchupProblem(7, { start: new Date(start.getTime() - 13 * 3_600_000), end }, now)).toBe('too_long');
  });

  it('a later licence start narrows the window', () => {
    expect(catchupProblem(7, { start, end }, now, new Date('2026-10-20T19:00:00Z'))).toBe('outside_window');
    expect(catchupProblem(7, { start, end }, now, new Date('2026-10-20T17:00:00Z'))).toBeNull();
  });
});

describe('panel time zones', () => {
  it('offsets of IANA zones, including DST, and unknown zones as UTC', () => {
    expect(zoneOffsetMinutes('Asia/Tbilisi', start)).toBe(240);
    expect(zoneOffsetMinutes('Europe/Berlin', new Date('2026-07-01T12:00:00Z'))).toBe(120);
    expect(zoneOffsetMinutes('Europe/Berlin', new Date('2026-12-01T12:00:00Z'))).toBe(60);
    expect(zoneOffsetMinutes('Not/AZone', start)).toBe(0);
    expect(zoneOffsetMinutes(null, start)).toBe(0);
    expect(validTimeZone('Europe/Amsterdam')).toBe('Europe/Amsterdam');
    expect(validTimeZone('Mars/Base')).toBeNull();
    expect(validTimeZone(42)).toBeNull();
  });
});

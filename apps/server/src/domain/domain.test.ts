import { describe, expect, it } from 'vitest';

import { isAdultEntry, isAdultLabel } from './catalog/adult.js';
import { parseCatchup } from './catalog/catchup.js';
import { classifyEntry, extractYear, parseEpisodeName } from './catalog/classify.js';
import { createContentKeyFactory, episodeKey } from './catalog/content-key.js';
import { kindFromExtension, planCandidates } from './playback/plan.js';
import { normalizeChannelName, queryTerms, searchTokens } from './shared/text.js';
import { evaluateHealth, maskUsername, nextSyncAt, problemFromAccount, problemFromHttpStatus } from './sources/source.js';

describe('catalog classification', () => {
  const classify = (url: string, name: string, duration = -1, attributes: Record<string, string> = {}) =>
    classifyEntry({ url: new URL(url), name, duration, attributes });

  it('keeps live channels live (even with mp4 loops) and finds Xtream VOD by URL layout', () => {
    expect(classify('http://h/live/u/p/1.ts', 'BBC One').kind).toBe('live');
    expect(classify('http://h/u/p/1', 'BBC One').kind).toBe('live');
    expect(classify('http://h/loop.mp4', 'Loop channel').kind).toBe('live'); // no duration → live
    expect(classify('http://h/movie/u/p/77.mp4', 'The Matrix (1999)', 5400).kind).toBe('movie');
    expect(classify('http://h/series/u/p/501.mkv', 'Breaking Bad S01E02')).toEqual({
      kind: 'episode',
      episode: { seriesName: 'Breaking Bad', season: 1, episode: 2, title: '' },
    });
    expect(classify('http://h/files/x.mkv', 'Some Film', 6000).kind).toBe('movie');
    expect(classify('http://h/x', 'Doc', -1, { 'tvg-type': 'movie' }).kind).toBe('movie');
    // A series item without SxxEyy cannot be placed in a season → movie.
    expect(classify('http://h/series/u/p/9.mkv', 'Special').kind).toBe('movie');
  });

  it('parses episode names in common notations', () => {
    expect(parseEpisodeName("Breaking Bad S01E02 - Cat's in the Bag")).toEqual({ seriesName: 'Breaking Bad', season: 1, episode: 2, title: "Cat's in the Bag" });
    expect(parseEpisodeName('Show.S2.E10')).toMatchObject({ seriesName: 'Show', season: 2, episode: 10 });
    expect(parseEpisodeName('Lost 3x07 Not in Portland')).toMatchObject({ seriesName: 'Lost', season: 3, episode: 7, title: 'Not in Portland' });
    expect(parseEpisodeName('Сериал Сезон 1 Серия 4')).toMatchObject({ seriesName: 'Сериал', season: 1, episode: 4 });
    expect(parseEpisodeName('Just a movie')).toBeNull();
  });

  it('extracts the release year from titles', () => {
    expect(extractYear('The Matrix (1999)')).toEqual({ title: 'The Matrix', year: 1999 });
    expect(extractYear('Dune - 2021')).toEqual({ title: 'Dune', year: 2021 });
    expect(extractYear('2012')).toEqual({ title: '2012', year: null });
    expect(extractYear('Blade Runner 2049')).toEqual({ title: 'Blade Runner 2049', year: null });
  });

  it('keys are stable, URL-safe and unique per duplicate (2.x compatible)', () => {
    const next = createContentKeyFactory();
    const first = next({ name: 'BBC One', groups: ['UK'] });
    expect(first).toMatch(/^[a-f0-9]{12}$/);
    expect(next({ name: 'bbc one', groups: ['uk'] })).toBe(`${first}-2`);
    expect(createContentKeyFactory()({ name: 'BBC One', groups: ['UK'] })).toBe(first);
    expect(episodeKey('abc', 1, 2)).not.toBe(episodeKey('abc', 2, 1));
  });

  it('reads catch-up attributes (TiviMate/Kodi conventions) with header defaults', () => {
    expect(parseCatchup({ catchup: 'shift', 'catchup-days': '7' })).toEqual({ mode: 'shift', days: 7, template: null });
    expect(parseCatchup({ catchup: 'append', 'catchup-source': '?utc={utc}' })).toEqual({ mode: 'append', days: 1, template: '?utc={utc}' });
    expect(parseCatchup({ 'tvg-rec': '3' })).toEqual({ mode: 'shift', days: 3, template: null });
    expect(parseCatchup({ catchup: 'xc', 'catchup-days': '5' })).toMatchObject({ mode: 'xtream', days: 5 });
    expect(parseCatchup({}, { catchup: 'flussonic', 'catchup-days': '2' })).toMatchObject({ mode: 'flussonic', days: 2 });
    expect(parseCatchup({ catchup: 'default' })).toEqual({ mode: 'shift', days: 1, template: null });
    expect(parseCatchup({ 'catchup-days': '0' })).toBeNull();
    expect(parseCatchup({})).toBeNull();
  });

  it('detects adult content from labels, not substrings of normal words', () => {
    expect(isAdultLabel('XXX Movies')).toBe(true);
    expect(isAdultLabel('For Adults')).toBe(true);
    expect(isAdultLabel('18+')).toBe(true);
    expect(isAdultLabel('Для взрослых')).toBe(true);
    expect(isAdultLabel('Adult Swim')).toBe(true); // conservative on purpose
    expect(isAdultLabel('Sports')).toBe(false);
    expect(isAdultLabel('Maxxx Sports')).toBe(false);
    expect(isAdultEntry({ name: 'Channel', groups: ['Kids', 'XXX'] })).toBe(true);
  });
});

describe('text rules', () => {
  it('normalises channel names for EPG matching and alternates', () => {
    expect(normalizeChannelName('UK: BBC One HD')).toBe('bbc one');
    expect(normalizeChannelName('|UK| BBC ONE FHD')).toBe('bbc one');
    expect(normalizeChannelName('BBC One (1080p) [Backup]')).toBe('bbc one');
    expect(normalizeChannelName('BBC One +1')).toBe('bbc one +1');
    expect(normalizeChannelName('Rustavi 2 HD')).toBe('rustavi 2');
    expect(normalizeChannelName('რუსთავი 2')).toBe('რუსთავი 2');
  });

  it('builds prefix-search tokens and query terms', () => {
    expect(searchTokens('Sky Sports F1 HD', 'skysports.f1')).toEqual(['sky', 'sports', 'f1', 'hd', 'skysports']);
    expect(searchTokens('Télé Monte-Carlo')).toEqual(['tele', 'monte', 'carlo']);
    expect(queryTerms('  Spo  F1 ')).toEqual(['spo', 'f1']);
  });
});

describe('source rules', () => {
  const now = new Date('2026-10-01T12:00:00Z');

  it('schedules syncs: interval on success, capped backoff on failure, never for files', () => {
    expect(nextSyncAt({ type: 'm3u_url', autoSync: true, intervalHours: 6, now, consecutiveFailures: 0 })?.toISOString()).toBe('2026-10-01T18:00:00.000Z');
    expect(nextSyncAt({ type: 'm3u_url', autoSync: true, intervalHours: 6, now, consecutiveFailures: 1 })?.toISOString()).toBe('2026-10-01T12:15:00.000Z');
    expect(nextSyncAt({ type: 'm3u_url', autoSync: true, intervalHours: 6, now, consecutiveFailures: 3 })?.toISOString()).toBe('2026-10-01T13:00:00.000Z');
    expect(nextSyncAt({ type: 'm3u_url', autoSync: true, intervalHours: 1, now, consecutiveFailures: 9 })?.toISOString()).toBe('2026-10-01T13:00:00.000Z');
    expect(nextSyncAt({ type: 'm3u_file', autoSync: true, intervalHours: 6, now, consecutiveFailures: 0 })).toBeNull();
    expect(nextSyncAt({ type: 'xtream', autoSync: false, intervalHours: 6, now, consecutiveFailures: 0 })).toBeNull();
  });

  it('classifies failures for the UX', () => {
    expect(problemFromHttpStatus(401)).toBe('auth_failed');
    expect(problemFromHttpStatus(403)).toBe('auth_failed');
    expect(problemFromHttpStatus(404)).toBe('expired');
    expect(problemFromHttpStatus(503)).toBe('unavailable');
    expect(problemFromAccount({ status: 'Active', expiresAt: new Date('2027-01-01') }, now)).toBeNull();
    expect(problemFromAccount({ status: 'Active', expiresAt: new Date('2026-01-01') }, now)).toBe('expired');
    expect(problemFromAccount({ status: 'Banned', expiresAt: null }, now)).toBe('auth_failed');
  });

  it('derives health from reachability, latency and stream telemetry', () => {
    const base = { reachable: true, latencyMs: 200, offlineStreams: 0, unstableStreams: 0, sampled: 0 };
    expect(evaluateHealth(base)).toBe('online');
    expect(evaluateHealth({ ...base, latencyMs: 4000 })).toBe('slow');
    expect(evaluateHealth({ ...base, unstableStreams: 2 })).toBe('unstable');
    expect(evaluateHealth({ ...base, offlineStreams: 3, sampled: 3 })).toBe('offline');
    expect(evaluateHealth({ ...base, reachable: false })).toBe('offline');
  });

  it('masks usernames', () => {
    expect(maskUsername('zurab123')).toBe('zu•••23');
    expect(maskUsername('abc')).toBe('a•••');
  });
});

describe('playback planning', () => {
  const proxyUrl = () => '/proxy';

  it('direct first, proxy as CORS fallback', () => {
    expect(planCandidates({ kind: 'hls', url: 'https://h/a.m3u8', headers: {}, secureContext: true, proxyEnabled: true, policy: 'auto', proxyUrl })).toEqual([
      { engine: 'hls', url: 'https://h/a.m3u8', via: 'direct' },
      { engine: 'hls', url: '/proxy', via: 'proxy' },
    ]);
  });

  it('proxy only for mixed content; proxy first when headers are needed', () => {
    expect(planCandidates({ kind: 'mpegts', url: 'http://h/1.ts', headers: {}, secureContext: true, proxyEnabled: true, policy: 'auto', proxyUrl }).map((c) => c.via)).toEqual(['proxy']);
    expect(planCandidates({ kind: 'hls', url: 'https://h/a', headers: { 'user-agent': 'X' }, secureContext: true, proxyEnabled: true, policy: 'auto', proxyUrl }).map((c) => c.via)).toEqual(['proxy', 'direct']);
    expect(planCandidates({ kind: 'dash', url: 'http://h/a.mpd', headers: {}, secureContext: true, proxyEnabled: true, policy: 'auto', proxyUrl })).toEqual([]);
    expect(planCandidates({ kind: 'unknown', url: 'https://h/x', headers: {}, secureContext: false, proxyEnabled: false, policy: 'auto', proxyUrl }).map((c) => c.engine)).toEqual(['hls', 'mpegts', 'native']);
  });

  it('proxy policy never hands out the upstream URL', () => {
    const plan = (kind: 'hls' | 'mpegts' | 'dash' | 'unknown', url: string, secureContext: boolean) =>
      planCandidates({ kind, url, headers: {}, secureContext, proxyEnabled: true, policy: 'proxy', proxyUrl });
    expect(plan('hls', 'https://h/a.m3u8', false)).toEqual([{ engine: 'hls', url: '/proxy', via: 'proxy' }]);
    expect(plan('unknown', 'https://h/x', true).map((c) => c.via)).toEqual(['proxy', 'proxy', 'proxy']);
    expect(plan('dash', 'https://h/a.mpd', false)).toEqual([]);
    expect(JSON.stringify(plan('mpegts', 'https://secret.example/u/p/1.ts', false))).not.toContain('secret.example');
  });

  it('maps VOD container extensions', () => {
    expect(kindFromExtension('mp4')).toBe('progressive');
    expect(kindFromExtension('MKV')).toBe('progressive');
    expect(kindFromExtension('m3u8')).toBe('hls');
    expect(kindFromExtension('avi')).toBe('unknown');
  });
});

import { describe, expect, it } from 'vitest';

import { chooseActiveFeed, playbackOrder, type FailoverFeed, type FailoverState } from './failover.js';
import { combineRegions, INITIAL_REGION_HEALTH, isProviderOutage, nextRegionHealth, type ProbeOutcome, type RegionHealth } from './feed-health.js';
import { cheapestVariant, liveProgress, outcomeOfStatus, parseMediaPlaylist, parseVariants } from './hls-manifest.js';
import { classifySourceHealth } from './source-health.js';

const run = (outcomes: ProbeOutcome[], start: RegionHealth = INITIAL_REGION_HEALTH) => outcomes.reduce((state, outcome) => nextRegionHealth(state, outcome, { failAfter: 3, recoverAfter: 2 }), start);

describe('feed health state machine', () => {
  it('trusts the first success, but needs consecutive failures to fail (hysteresis)', () => {
    expect(run(['ok']).state).toBe('HEALTHY');
    expect(run(['ok', 'unreachable', 'unreachable']).state).toBe('HEALTHY');
    expect(run(['ok', 'unreachable', 'unreachable', 'unreachable']).state).toBe('UNHEALTHY');
    expect(run(['ok', 'unreachable', 'ok', 'unreachable', 'unreachable']).state).toBe('HEALTHY');
  });

  it('needs consecutive successes to recover; the kind of failure can change while failing', () => {
    const failing = run(['unreachable', 'unreachable', 'unreachable']);
    expect(failing.state).toBe('UNHEALTHY');
    expect(run(['ok'], failing).state).toBe('UNHEALTHY');
    expect(run(['ok', 'ok'], failing).state).toBe('HEALTHY');
    expect(run(['ok', 'stalled', 'ok'], failing).state).toBe('UNHEALTHY');
    expect(run(['geo_blocked'], failing).state).toBe('GEO_BLOCKED');
    expect(run(['degraded', 'degraded'], failing).state).toBe('HEALTHY');
  });

  it('combines regions by consensus; maintenance and provider outages override', () => {
    const view = (state: RegionHealth['state'], fresh = true) => ({ region: 'x', state, fresh });
    expect(combineRegions([view('UNHEALTHY'), view('HEALTHY')], { maintenance: false, providerOutage: false })).toBe('HEALTHY');
    expect(combineRegions([view('UNHEALTHY'), view('HEALTHY', false)], { maintenance: false, providerOutage: false })).toBe('UNHEALTHY');
    expect(combineRegions([view('UNHEALTHY'), view('UNKNOWN')], { maintenance: false, providerOutage: true })).toBe('PROVIDER_OUTAGE');
    expect(combineRegions([view('GEO_BLOCKED'), view('GEO_BLOCKED')], { maintenance: false, providerOutage: false })).toBe('GEO_BLOCKED');
    expect(combineRegions([view('GEO_BLOCKED'), view('NOT_ENTITLED')], { maintenance: false, providerOutage: false })).toBe('NOT_ENTITLED');
    expect(combineRegions([view('HEALTHY')], { maintenance: true, providerOutage: false })).toBe('MAINTENANCE');
    expect(combineRegions([], { maintenance: false, providerOutage: false })).toBe('UNKNOWN');
    expect(isProviderOutage([{ failing: true }, { failing: true }, { failing: false }])).toBe(false);
    expect(isProviderOutage([{ failing: true }, { failing: true }, { failing: true }, { failing: false }])).toBe(true);
  });
});

describe('failover', () => {
  const at = new Date('2026-10-27T12:00:00Z');
  const feed = (id: string, priority: number, health: FailoverFeed['health']): FailoverFeed => ({ id, priority, createdAt: at, health });
  const state = (patch: Partial<FailoverState> = {}): FailoverState => ({ activeFeedId: 'a', pinnedFeedId: null, pinnedUntil: null, lastSwitchAt: null, ...patch });

  it('switches away from a failing feed immediately and only within the channel’s feeds', () => {
    const decision = chooseActiveFeed([feed('a', 100, 'UNHEALTHY'), feed('b', 110, 'HEALTHY')], state(), at);
    expect(decision).toEqual({ activeFeedId: 'b', reason: 'unhealthy', switched: true });
    expect(chooseActiveFeed([feed('a', 100, 'UNHEALTHY'), feed('b', 110, 'UNHEALTHY')], state(), at)).toMatchObject({ activeFeedId: 'a', switched: false });
    expect(chooseActiveFeed([], state(), at)).toMatchObject({ activeFeedId: null, reason: 'no_feed' });
    expect(chooseActiveFeed([feed('a', 100, 'UNKNOWN')], state({ activeFeedId: null }), at)).toMatchObject({ activeFeedId: 'a', reason: 'initial' });
    expect(chooseActiveFeed([feed('a', 100, 'UNKNOWN'), feed('b', 110, 'HEALTHY')], state({ activeFeedId: null }), at)).toMatchObject({ activeFeedId: 'a', reason: 'initial' });
    expect(chooseActiveFeed([feed('a', 100, 'UNHEALTHY'), feed('b', 110, 'UNKNOWN')], state({ activeFeedId: null }), at)).toMatchObject({ activeFeedId: 'b', reason: 'initial' });
  });

  it('fails back to the primary only when healthy and after the cooldown', () => {
    const feeds = [feed('a', 100, 'HEALTHY'), feed('b', 110, 'HEALTHY')];
    const onBackup = state({ activeFeedId: 'b', lastSwitchAt: new Date(at.getTime() - 5 * 60_000) });
    expect(chooseActiveFeed(feeds, onBackup, at, { cooldownMs: 10 * 60_000 })).toMatchObject({ activeFeedId: 'b', reason: 'unchanged' });
    expect(chooseActiveFeed(feeds, { ...onBackup, lastSwitchAt: new Date(at.getTime() - 11 * 60_000) }, at, { cooldownMs: 10 * 60_000 })).toMatchObject({ activeFeedId: 'a', reason: 'failback' });
    expect(chooseActiveFeed([feed('a', 100, 'UNKNOWN'), feed('b', 110, 'HEALTHY')], { ...onBackup, lastSwitchAt: null }, at)).toMatchObject({ activeFeedId: 'b' });
  });

  it('an operator pin wins until it expires or its feed goes into maintenance', () => {
    const feeds = [feed('a', 100, 'HEALTHY'), feed('b', 110, 'UNHEALTHY')];
    expect(chooseActiveFeed(feeds, state({ pinnedFeedId: 'b' }), at)).toMatchObject({ activeFeedId: 'b', reason: 'pinned', switched: true });
    expect(chooseActiveFeed(feeds, state({ pinnedFeedId: 'b', pinnedUntil: new Date(at.getTime() - 1) }), at)).toMatchObject({ activeFeedId: 'a', reason: 'unchanged' });
    expect(chooseActiveFeed([feed('a', 100, 'HEALTHY'), feed('b', 110, 'MAINTENANCE')], state({ pinnedFeedId: 'b' }), at)).toMatchObject({ activeFeedId: 'a' });
  });

  it('orders playback candidates: active first, working before failing, maintenance never', () => {
    const order = playbackOrder([feed('a', 100, 'UNHEALTHY'), feed('b', 110, 'HEALTHY'), feed('c', 120, 'UNKNOWN'), feed('d', 90, 'MAINTENANCE')], 'c');
    expect(order.map((f) => f.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('HLS probing helpers', () => {
  it('picks the cheapest variant and reads the media playlist', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nhi.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nlo.m3u8\n';
    expect(cheapestVariant(parseVariants(master))?.uri).toBe('lo.m3u8');
    const media = parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:42\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n');
    expect(media).toEqual({ mediaSequence: 42, targetDurationSecs: 6, segments: ['a.ts', 'b.ts'], endList: false, map: null });
    expect(parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="/init.mp4"\n#EXTINF:4,\ns1.m4s\n')?.map).toBe('/init.mp4');
    expect(parseMediaPlaylist('<html>')).toBeNull();
  });

  it('detects a frozen live window', () => {
    const t0 = new Date('2026-10-27T12:00:00Z');
    const later = (secs: number) => new Date(t0.getTime() + secs * 1000);
    const prev = { mediaSequence: 42, lastSegment: 'b.ts', at: t0 };
    expect(liveProgress(null, { mediaSequence: 42, lastSegment: 'b.ts', targetDurationSecs: 6, at: t0 })).toBe('first');
    expect(liveProgress(prev, { mediaSequence: 43, lastSegment: 'c.ts', targetDurationSecs: 6, at: later(60) })).toBe('advancing');
    expect(liveProgress(prev, { mediaSequence: 42, lastSegment: 'b.ts', targetDurationSecs: 6, at: later(20) })).toBe('advancing');
    expect(liveProgress(prev, { mediaSequence: 42, lastSegment: 'b.ts', targetDurationSecs: 6, at: later(60) })).toBe('stalled');
  });

  it('classifies error statuses', () => {
    expect(outcomeOfStatus(200)).toBeNull();
    expect(outcomeOfStatus(451)).toBe('geo_blocked');
    expect(outcomeOfStatus(403, 'Not available in your country')).toBe('geo_blocked');
    expect(outcomeOfStatus(403)).toBe('not_entitled');
    expect(outcomeOfStatus(502)).toBe('http_error');
  });
});

describe('BYO source health', () => {
  const ok = (latencyMs = 200) => ({ ok: true, latencyMs });
  const fail = { ok: false, latencyMs: null };
  const quiet = { starts: 0, errors: 0, avgStartupMs: null };
  it('online / slow / unstable / offline', () => {
    expect(classifySourceHealth([], quiet)).toBe('unknown');
    expect(classifySourceHealth([ok()], quiet)).toBe('online');
    expect(classifySourceHealth([ok(4_000)], quiet)).toBe('slow');
    expect(classifySourceHealth([ok()], { starts: 4, errors: 0, avgStartupMs: 9_000 })).toBe('slow');
    expect(classifySourceHealth([ok()], { starts: 6, errors: 4, avgStartupMs: 1_000 })).toBe('unstable');
    expect(classifySourceHealth([ok(), fail, ok(), fail], quiet)).toBe('unstable');
    expect(classifySourceHealth([fail, fail, ok()], quiet)).toBe('offline');
    expect(classifySourceHealth([fail], quiet)).toBe('unstable');
  });
});

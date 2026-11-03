/**
 * Stream health of operator feeds (ZP-ENT-06).
 *
 * A probe produces an outcome; outcomes drive a per-region state machine with hysteresis (one bad
 * probe never flips a feed, one good probe never brings it back); the regions are combined into
 * the feed's overall state by consensus (a feed is only failing when every region that has
 * recently probed it sees it failing), so a network problem at one probe location cannot trigger
 * a failover by itself.
 */

export const FEED_HEALTH_STATES = ['HEALTHY', 'UNHEALTHY', 'GEO_BLOCKED', 'NOT_ENTITLED', 'MAINTENANCE', 'PROVIDER_OUTAGE', 'UNKNOWN'] as const;
export type FeedHealthState = (typeof FEED_HEALTH_STATES)[number];

/** What one probe concluded. `degraded` = works, but slow (counts as a success). */
export const PROBE_OUTCOMES = ['ok', 'degraded', 'stalled', 'unreachable', 'http_error', 'geo_blocked', 'not_entitled', 'invalid_media'] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

/** States a probe location can reach on its own (maintenance and outages are decided above it). */
export type RegionState = 'HEALTHY' | 'UNHEALTHY' | 'GEO_BLOCKED' | 'NOT_ENTITLED' | 'UNKNOWN';
type FailingState = 'UNHEALTHY' | 'GEO_BLOCKED' | 'NOT_ENTITLED';

export interface HealthPolicy {
  /** Consecutive failed probes before a working feed is declared failing. */
  failAfter: number;
  /** Consecutive good probes before a failing feed is declared healthy again. */
  recoverAfter: number;
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = { failAfter: 3, recoverAfter: 3 };

export interface RegionHealth {
  state: RegionState;
  /** Consecutive failed probes (0 after a success). */
  failures: number;
  /** Consecutive good probes (0 after a failure). */
  successes: number;
}

export const INITIAL_REGION_HEALTH: RegionHealth = { state: 'UNKNOWN', failures: 0, successes: 0 };

export function isSuccess(outcome: ProbeOutcome): boolean {
  return outcome === 'ok' || outcome === 'degraded';
}

/** The state a failed outcome points to. */
export function failureState(outcome: ProbeOutcome): FailingState {
  switch (outcome) {
    case 'geo_blocked':
      return 'GEO_BLOCKED';
    case 'not_entitled':
      return 'NOT_ENTITLED';
    default:
      return 'UNHEALTHY';
  }
}

export function isFailing(state: FeedHealthState): boolean {
  return state === 'UNHEALTHY' || state === 'GEO_BLOCKED' || state === 'NOT_ENTITLED' || state === 'PROVIDER_OUTAGE';
}

/** One probe result applied to one region's state (hysteresis in both directions). */
export function nextRegionHealth(current: RegionHealth, outcome: ProbeOutcome, policy: HealthPolicy = DEFAULT_HEALTH_POLICY): RegionHealth {
  if (isSuccess(outcome)) {
    const successes = current.successes + 1;
    const failing = current.state !== 'HEALTHY' && current.state !== 'UNKNOWN';
    // First evidence about a new feed: trust it. A failing feed must prove itself `recoverAfter` times.
    const state: RegionState = !failing || successes >= policy.recoverAfter ? 'HEALTHY' : current.state;
    return { state, failures: 0, successes };
  }
  const failures = current.failures + 1;
  const target = failureState(outcome);
  const failing = current.state !== 'HEALTHY' && current.state !== 'UNKNOWN';
  // Already failing: the kind of failure may change (e.g. unreachable → geo-blocked) right away.
  const state: RegionState = failing || failures >= policy.failAfter ? target : current.state;
  return { state, failures, successes: 0 };
}

export interface RegionView {
  region: string;
  state: RegionState;
  /** Probed recently enough to vote. */
  fresh: boolean;
}

/**
 * Overall state of a feed from its probe regions.
 *   maintenance (operator)  → MAINTENANCE
 *   any fresh region healthy → HEALTHY (a failure seen from one place only is not a feed failure)
 *   no fresh evidence        → UNKNOWN
 *   otherwise failing: NOT_ENTITLED if any region says so (credentials/contract), GEO_BLOCKED if
 *   every failing region is geo-blocked, else UNHEALTHY — PROVIDER_OUTAGE when the whole provider
 *   is down (decided by `isProviderOutage`).
 */
export function combineRegions(regions: readonly RegionView[], context: { maintenance: boolean; providerOutage: boolean }): FeedHealthState {
  if (context.maintenance) return 'MAINTENANCE';
  const fresh = regions.filter((region) => region.fresh && region.state !== 'UNKNOWN');
  if (fresh.length === 0) return 'UNKNOWN';
  if (fresh.some((region) => region.state === 'HEALTHY')) return 'HEALTHY';
  if (fresh.some((region) => region.state === 'NOT_ENTITLED')) return 'NOT_ENTITLED';
  if (fresh.every((region) => region.state === 'GEO_BLOCKED')) return 'GEO_BLOCKED';
  return context.providerOutage ? 'PROVIDER_OUTAGE' : 'UNHEALTHY';
}

/**
 * A provider is "out" when a large share of its feeds fail at the same time (its origin or CDN is
 * down): one incident for the provider instead of one per channel.
 */
export function isProviderOutage(feeds: readonly { failing: boolean }[], policy: { minFeeds: number; ratio: number } = { minFeeds: 3, ratio: 0.5 }): boolean {
  const failing = feeds.filter((feed) => feed.failing).length;
  return failing >= policy.minFeeds && failing >= Math.ceil(feeds.length * policy.ratio);
}

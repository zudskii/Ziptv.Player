import { isFailing, type FeedHealthState } from './feed-health.js';

/**
 * Failover between the feeds of ONE master channel. It never crosses channels: every candidate
 * is a licensed feed of the same channel (rights are checked for the channel before playback).
 *
 *   operator pin (not expired, feed still exists, not in maintenance) → the pinned feed
 *   no active feed yet                 → the preferred feed that is not known to fail
 *   active feed failing                → best working feed, immediately
 *   a higher-priority feed is healthy  → fail back, but only after the cooldown since the last
 *                                        switch (no flapping between primary and backup)
 *   nothing works                      → stay (the player still tries every feed)
 */

export interface FailoverFeed {
  id: string;
  /** Lower = preferred (primary first). */
  priority: number;
  createdAt: Date;
  health: FeedHealthState;
}

export interface FailoverState {
  activeFeedId: string | null;
  pinnedFeedId: string | null;
  /** null = until released. */
  pinnedUntil: Date | null;
  lastSwitchAt: Date | null;
}

export interface FailoverPolicy {
  /** Minimum time between an automatic switch and a fail-back to a preferred feed. */
  cooldownMs: number;
}

export const DEFAULT_FAILOVER_POLICY: FailoverPolicy = { cooldownMs: 10 * 60_000 };

export type FailoverReason = 'pinned' | 'initial' | 'unhealthy' | 'failback' | 'unchanged' | 'no_feed';

export interface FailoverDecision {
  activeFeedId: string | null;
  reason: FailoverReason;
  /** True when `activeFeedId` differs from the current one. */
  switched: boolean;
}

function byPriority(a: FailoverFeed, b: FailoverFeed): number {
  return a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime();
}

export function isPinActive(state: FailoverState, now: Date): boolean {
  return state.pinnedFeedId !== null && (state.pinnedUntil === null || state.pinnedUntil.getTime() > now.getTime());
}

/** The preferred working feed: healthy by priority, else not-yet-probed by priority. */
export function bestFeed(feeds: readonly FailoverFeed[]): FailoverFeed | null {
  const sorted = [...feeds].sort(byPriority);
  return sorted.find((feed) => feed.health === 'HEALTHY') ?? sorted.find((feed) => feed.health === 'UNKNOWN') ?? null;
}

export function chooseActiveFeed(feeds: readonly FailoverFeed[], state: FailoverState, now: Date, policy: FailoverPolicy = DEFAULT_FAILOVER_POLICY): FailoverDecision {
  const current = feeds.find((feed) => feed.id === state.activeFeedId) ?? null;
  const decide = (feed: FailoverFeed | null, reason: FailoverReason): FailoverDecision => {
    const activeFeedId = feed?.id ?? null;
    return { activeFeedId, reason, switched: activeFeedId !== state.activeFeedId };
  };

  if (feeds.length === 0) return decide(null, 'no_feed');

  if (isPinActive(state, now)) {
    const pinned = feeds.find((feed) => feed.id === state.pinnedFeedId);
    // The operator's choice stands even when probes disagree; only a vanished or maintenance
    // feed falls through to automatic selection.
    if (pinned && pinned.health !== 'MAINTENANCE') return decide(pinned, 'pinned');
  }

  const best = bestFeed(feeds);
  // First decision: the preferred feed unless it is already known to fail (an unprobed primary is
  // presumed fine — choosing a probed backup first would pin the channel to it for a cooldown).
  if (!current) {
    const sorted = [...feeds].sort(byPriority);
    return decide(sorted.find((feed) => feed.health === 'HEALTHY' || feed.health === 'UNKNOWN') ?? sorted[0]!, 'initial');
  }

  if (isFailing(current.health) || current.health === 'MAINTENANCE') {
    if (best && best.id !== current.id) return decide(best, 'unhealthy');
    return decide(current, 'unchanged');
  }

  // Fail back to a preferred feed only when it is proven healthy and the cooldown has passed.
  if (best && best.id !== current.id && best.health === 'HEALTHY' && byPriority(best, current) < 0) {
    const sinceSwitch = state.lastSwitchAt ? now.getTime() - state.lastSwitchAt.getTime() : Number.POSITIVE_INFINITY;
    if (sinceSwitch >= policy.cooldownMs) return decide(best, 'failback');
  }
  return decide(current, 'unchanged');
}

const RANK: Record<FeedHealthState, number> = {
  HEALTHY: 0,
  UNKNOWN: 1,
  PROVIDER_OUTAGE: 2,
  UNHEALTHY: 2,
  GEO_BLOCKED: 3,
  NOT_ENTITLED: 4,
  MAINTENANCE: 99,
};

/**
 * Candidate order for the player: the active feed first, then the others — working before
 * failing, by priority. Feeds in maintenance are never offered.
 */
export function playbackOrder<T extends FailoverFeed>(feeds: readonly T[], activeFeedId: string | null): T[] {
  return feeds
    .filter((feed) => feed.health !== 'MAINTENANCE')
    .sort((a, b) => Number(b.id === activeFeedId) - Number(a.id === activeFeedId) || RANK[a.health] - RANK[b.health] || byPriority(a, b));
}

import { chooseActiveFeed, DEFAULT_FAILOVER_POLICY, isPinActive, type FailoverPolicy } from '../../domain/health/failover.js';
import { combineRegions, isFailing, isProviderOutage, type FeedHealthState } from '../../domain/health/feed-health.js';
import { newEntityId } from '../../domain/shared/ids.js';
import type { Clock } from '../ports/clock.js';
import type { AlertChannel, FailoverEventReason, HealthRepository, IncidentKind, IncidentRecord, Metrics } from '../ports/health.js';
import type { Logger } from '../ports/logger.js';
import type { OperatorCatalogRepository } from '../ports/operator.js';

export interface EvaluatorConfig {
  /** A region's verdict counts while its last probe is younger than this. */
  freshnessMs: number;
  failover: FailoverPolicy;
  /** Configured alert destinations (one outbox message each). */
  alertChannels: AlertChannel[];
}

export interface Actor {
  id: string;
  email: string;
}

/**
 * Turns probe results into decisions, transactionally:
 *   feed:     regions (consensus) + maintenance + provider outage → overall state; incidents
 *   channel:  failover (active feed, pin expiry), journal; "channel down" incident
 *   provider: outage incident
 * Every incident change enqueues its alerts in the same transaction (outbox).
 */
export class HealthEvaluator {
  constructor(
    private readonly deps: {
      health: HealthRepository;
      catalog: Pick<OperatorCatalogRepository, 'findFeed' | 'findChannel' | 'findProvider'>;
      clock: Clock;
      metrics: Metrics;
      logger: Logger;
      config: EvaluatorConfig;
      /** A channel's active feed changed (viewer caches, metrics). */
      onSwitch?: (channelId: string) => void;
    },
  ) {}

  /**
   * Re-derives a feed's overall state (after a probe, maintenance change, …). `repository`: run
   * inside a caller's transaction (e.g. the console's, so the change and its effects commit together).
   */
  async evaluateFeed(feedId: string, repository: HealthRepository = this.deps.health): Promise<{ status: FeedHealthState; changed: boolean } | null> {
    const feed = await this.deps.catalog.findFeed(feedId);
    if (!feed) return null;
    const [channel, provider] = await Promise.all([this.deps.catalog.findChannel(feed.channelId), this.deps.catalog.findProvider(feed.providerId)]);
    const switched: string[] = [];
    const incidents: { kind: IncidentKind; event: 'opened' | 'resolved' }[] = [];

    const result = await repository.transaction(async (tx) => {
      const now = this.deps.clock.now();
      const current = await tx.lockFeedHealth(feedId);
      const regions = (await tx.regionStates(feedId)).map((region) => ({
        region: region.region,
        state: region.state,
        fresh: region.lastProbeAt !== null && now.getTime() - region.lastProbeAt.getTime() <= this.deps.config.freshnessMs,
      }));
      const own = combineRegions(regions, { maintenance: current.maintenance, providerOutage: false });
      // The provider's feeds, with this feed's fresh verdict instead of its stored status.
      const statuses = (await tx.providerFeedStatuses(feed.providerId)).map((entry) => (entry.feedId === feedId ? own : entry.status));
      const outage = isProviderOutage(statuses.map((status) => ({ failing: isFailing(status) })));
      const status: FeedHealthState = own === 'UNHEALTHY' && outage ? 'PROVIDER_OUTAGE' : own;

      const changed = status !== current.status;
      if (changed) {
        await tx.setFeedStatus(feedId, status, now);
        this.deps.logger.info({ feedId, channelId: feed.channelId, from: current.status, to: status }, 'Feed health changed');
      }

      // Incidents follow the state (idempotent: an open incident is refreshed, not duplicated).
      const label = `${channel?.name ?? 'Channel'} via ${provider?.name ?? 'provider'}`;
      if (isFailing(status)) {
        await this.open(tx, incidents, { kind: 'feed_unhealthy', severity: 'warning', targetType: 'feed', targetId: feedId, title: `Feed ${label}: ${status}`, details: { channelId: feed.channelId, providerId: feed.providerId, status } }, now);
      } else {
        await this.resolve(tx, incidents, 'feed_unhealthy', feedId, now);
      }
      if (outage) {
        await this.open(tx, incidents, { kind: 'provider_outage', severity: 'critical', targetType: 'provider', targetId: feed.providerId, title: `Provider outage: ${provider?.name ?? feed.providerId}`, details: { providerId: feed.providerId } }, now);
      } else {
        await this.resolve(tx, incidents, 'provider_outage', feed.providerId, now);
      }

      if (await this.evaluateChannelIn(tx, feed.channelId, now, null, null, channel?.name ?? null)) switched.push(feed.channelId);
      return { status, changed };
    });

    for (const channelId of switched) this.deps.onSwitch?.(channelId);
    for (const incident of incidents) this.deps.metrics.incident(incident.kind, incident.event);
    return result;
  }

  /** Failover decision of one channel in its own transaction (periodic fail-back, pin expiry). */
  async evaluateChannel(channelId: string): Promise<boolean> {
    // Read outside the transaction: a pool query while holding a transaction's connection can
    // exhaust the pool under load (every connection waiting for a second one).
    const channel = await this.deps.catalog.findChannel(channelId);
    const switched = await this.deps.health.transaction((tx) => this.evaluateChannelIn(tx, channelId, this.deps.clock.now(), null, null, channel?.name ?? null));
    if (switched) this.deps.onSwitch?.(channelId);
    return switched;
  }

  /**
   * Failover decision inside a transaction (used by operator overrides, which audit in the same
   * transaction). `announce`: journal the operator action even when the active feed stays.
   * Returns whether the active feed changed.
   */
  async evaluateChannelIn(tx: HealthRepository, channelId: string, now: Date, actor: Actor | null, announce: 'pinned' | 'unpinned' | null, channelName: string | null): Promise<boolean> {
    // Lock first, read after: a concurrent evaluation of another feed of this channel has then
    // committed, so its status is visible (otherwise both could decide on a stale picture).
    const state = await tx.lockFailover(channelId);
    const feeds = await tx.channelFeeds(channelId);
    const journal = (from: string | null, to: string | null, reason: FailoverEventReason, details: Record<string, unknown> = {}) =>
      tx.appendFailoverEvent({ channelId, occurredAt: now, fromFeedId: from, toFeedId: to, reason, actorId: actor?.id ?? null, actorEmail: actor?.email ?? null, details });

    let dirty = false;
    // An expired pin is released (and journaled) before deciding.
    if (state.pinnedFeedId && !isPinActive(state, now)) {
      dirty = true;
      await journal(state.activeFeedId, state.activeFeedId, 'unpinned', { expired: true, pinnedFeedId: state.pinnedFeedId });
      Object.assign(state, { pinnedFeedId: null, pinnedUntil: null, pinnedBy: null, pinNote: null });
    }

    const decision = chooseActiveFeed(feeds, state, now, this.deps.config.failover ?? DEFAULT_FAILOVER_POLICY);
    const from = state.activeFeedId;
    const reason: FailoverEventReason = announce ?? (decision.reason === 'unchanged' ? 'initial' : decision.reason);
    if (decision.switched) {
      state.activeFeedId = decision.activeFeedId;
      state.lastSwitchAt = now;
      await journal(from, decision.activeFeedId, reason, { health: Object.fromEntries(feeds.map((feed) => [feed.id, feed.health])) });
      this.deps.metrics.failover(reason);
      this.deps.logger.warn({ channelId, from, to: decision.activeFeedId, reason }, 'Failover');
      dirty = true;
    } else if (announce) {
      await journal(from, from, announce);
    }
    if (dirty) await tx.saveFailover(state, now);

    // Channel down: it has feeds, none works, and at least one is failing (feeds that are only in
    // planned maintenance do not page anyone).
    const incidents: { kind: IncidentKind; event: 'opened' | 'resolved' }[] = [];
    if (feeds.length > 0 && !feeds.some((feed) => feed.health === 'HEALTHY' || feed.health === 'UNKNOWN') && feeds.some((feed) => isFailing(feed.health))) {
      await this.open(tx, incidents, { kind: 'channel_down', severity: 'critical', targetType: 'channel', targetId: channelId, title: `Channel down: ${channelName ?? channelId}`, details: { feeds: feeds.length } }, now);
    } else {
      await this.resolve(tx, incidents, 'channel_down', channelId, now);
    }
    for (const incident of incidents) this.deps.metrics.incident(incident.kind, incident.event);
    return decision.switched;
  }

  /**
   * Incidents whose target left the playable catalog (feed disabled/deleted, provider paused,
   * channel merged away) are no longer re-evaluated by probes: resolve them (with alerts).
   */
  async resolveOrphans(): Promise<number> {
    const orphans = await this.deps.health.orphanIncidents();
    for (const incident of orphans) {
      const resolved = await this.deps.health.transaction(async (tx) => {
        const log: { kind: IncidentKind; event: 'opened' | 'resolved' }[] = [];
        await this.resolve(tx, log, incident.kind, incident.targetId, this.deps.clock.now());
        return log;
      });
      for (const entry of resolved) this.deps.metrics.incident(entry.kind, entry.event);
    }
    return orphans.length;
  }

  private async open(tx: HealthRepository, log: { kind: IncidentKind; event: 'opened' | 'resolved' }[], input: Omit<IncidentRecord, 'id' | 'status' | 'openedAt' | 'lastSeenAt' | 'acknowledgedAt' | 'acknowledgedBy' | 'resolvedAt' | 'resolvedBy'>, now: Date): Promise<void> {
    const { incident, created } = await tx.openIncident({ id: newEntityId(), ...input }, now);
    if (!created) return;
    log.push({ kind: input.kind, event: 'opened' });
    for (const channel of this.deps.config.alertChannels) await tx.enqueueAlert(channel, { incidentId: incident.id, event: 'opened' }, now);
  }

  private async resolve(tx: HealthRepository, log: { kind: IncidentKind; event: 'opened' | 'resolved' }[], kind: IncidentKind, targetId: string, now: Date): Promise<void> {
    const resolved = await tx.resolveIncident(kind, targetId, now, null);
    if (!resolved) return;
    log.push({ kind, event: 'resolved' });
    for (const channel of this.deps.config.alertChannels) await tx.enqueueAlert(channel, { incidentId: resolved.id, event: 'resolved' }, now);
  }
}

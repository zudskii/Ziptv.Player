import type { FailoverFeed } from '../../domain/health/failover.js';
import type { FeedHealthState, ProbeOutcome, RegionHealth, RegionState } from '../../domain/health/feed-health.js';
import type { StreamKind, StreamLocator } from '../../domain/catalog/model.js';
import type { SourceCredential } from '../../domain/sources/source.js';

// ---------------------------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------------------------

export type ProbeStepKind = 'manifest' | 'segment' | 'stream' | 'decode';

/** One request of a probe (a probe of an HLS feed = manifest(s) + a segment [+ decode]). */
export interface ProbeStep {
  kind: ProbeStepKind;
  outcome: ProbeOutcome;
  httpStatus: number | null;
  /** Time to the first response byte. */
  ttfbMs: number | null;
  durationMs: number;
  bytes: number | null;
  error: string | null;
}

export interface ProbeObservation {
  /** Worst outcome of the steps (liveness is judged by the caller from `playlist`). */
  outcome: ProbeOutcome;
  steps: ProbeStep[];
  /** Live HLS: the media playlist seen (for "is the window moving?"). */
  playlist: { mediaSequence: number; lastSegment: string | null; targetDurationSecs: number } | null;
  decoded: boolean;
}

/** Checks one stream the way a player would (but cheaper): manifest, a segment, optionally a decode. */
export interface FeedProber {
  probe(locator: StreamLocator, kind: StreamKind, options: { decode: boolean; signal: AbortSignal }): Promise<ProbeObservation>;
}

/** Container/codec check of a downloaded sample, without network access of its own. */
export interface MediaDecoder {
  /** null = no decoder available (decode probes are skipped). */
  inspect(sample: Buffer, signal: AbortSignal): Promise<{ ok: boolean; streams: string[]; error: string | null } | null>;
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

export interface ProbeTarget {
  feedId: string;
  region: string;
  channelId: string;
  providerId: string;
  streamId: string;
  health: RegionHealth;
  previous: { mediaSequence: number; lastSegment: string | null; at: Date } | null;
  lastDecodeAt: Date | null;
}

export interface ProbeResultRecord extends ProbeStep {
  feedId: string;
  region: string;
  probedAt: Date;
  mediaSequence: number | null;
}

export interface RegionStateRecord {
  region: string;
  state: RegionState;
  failures: number;
  successes: number;
  lastProbeAt: Date | null;
  lastOkAt: Date | null;
  lastOutcome: ProbeOutcome | null;
  lastError: string | null;
}

export interface FeedHealthRecord {
  feedId: string;
  channelId: string;
  channelName: string;
  providerId: string;
  providerName: string;
  priority: number;
  feedStatus: 'active' | 'disabled';
  status: FeedHealthState;
  since: Date;
  maintenance: boolean;
  maintenanceNote: string | null;
  regions: RegionStateRecord[];
}

export interface FailoverRecord {
  channelId: string;
  activeFeedId: string | null;
  pinnedFeedId: string | null;
  pinnedUntil: Date | null;
  pinnedBy: string | null;
  pinNote: string | null;
  lastSwitchAt: Date | null;
}

export type FailoverEventReason = 'initial' | 'unhealthy' | 'failback' | 'pinned' | 'unpinned' | 'no_feed';

export interface FailoverEventRecord {
  id: number;
  channelId: string;
  occurredAt: Date;
  fromFeedId: string | null;
  toFeedId: string | null;
  reason: FailoverEventReason;
  actorId: string | null;
  actorEmail: string | null;
  details: Record<string, unknown>;
}

export type IncidentKind = 'feed_unhealthy' | 'channel_down' | 'provider_outage';
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

export interface IncidentRecord {
  id: string;
  kind: IncidentKind;
  severity: 'warning' | 'critical';
  status: IncidentStatus;
  targetType: 'feed' | 'channel' | 'provider';
  targetId: string;
  title: string;
  details: Record<string, unknown>;
  openedAt: Date;
  lastSeenAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

/** A playable feed of a channel with its health (input of failover). */
export interface ChannelFeedHealth extends FailoverFeed {
  providerId: string;
}

export type TelemetrySubject = { type: 'feed' | 'source'; id: string };

export interface TelemetryStats {
  starts: number;
  errors: number;
  avgStartupMs: number | null;
}

// ---------------------------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------------------------

/**
 * Health, failover and incident state. Decisions that read-then-write (overall state, failover)
 * run in `transaction`, with the rows they decide on locked.
 */
export interface HealthRepository {
  transaction<T>(work: (tx: HealthRepository) => Promise<T>): Promise<T>;

  // probe scheduling (per region)
  /** Creates missing probe rows of this region for playable feeds; returns how many. */
  ensureProbeRows(region: string, now: Date): Promise<number>;
  /** Next due probe of this region, leased; at most `providerLimit` running probes per provider. */
  claimDueProbe(region: string, now: Date, owner: string, leaseUntil: Date, providerLimit: number): Promise<ProbeTarget | null>;
  heartbeatProbe(feedId: string, region: string, owner: string, leaseUntil: Date): Promise<boolean>;
  /** Stores the probe (state row + results) if the lease is still held. */
  completeProbe(
    target: { feedId: string; region: string },
    owner: string,
    update: {
      health: RegionHealth;
      outcome: ProbeOutcome;
      error: string | null;
      probedAt: Date;
      ok: boolean;
      nextProbeAt: Date;
      playlist: { mediaSequence: number; lastSegment: string | null } | null;
      /** Keep the previous window reference (the playlist did not move yet). */
      keepSequenceAt: boolean;
      decoded: boolean;
    },
    results: ProbeResultRecord[],
  ): Promise<boolean>;
  /** Probe soon, in every region (operator request, telemetry alarm). */
  requestProbe(feedId: string, now: Date): Promise<void>;
  /** Releases the lease and reschedules (target no longer probe-able right now). */
  postponeProbe(target: { feedId: string; region: string }, owner: string, nextProbeAt: Date): Promise<void>;

  // feed health
  regionStates(feedId: string): Promise<RegionStateRecord[]>;
  /** The feed's health row, locked (created when missing). */
  lockFeedHealth(feedId: string): Promise<{ status: FeedHealthState; since: Date; maintenance: boolean }>;
  setFeedStatus(feedId: string, status: FeedHealthState, now: Date): Promise<void>;
  setMaintenance(feedId: string, maintenance: boolean, note: string | null, now: Date): Promise<void>;
  /** Overall status of every active feed of a provider. */
  providerFeedStatuses(providerId: string): Promise<{ feedId: string; status: FeedHealthState }[]>;
  feedHealthList(query: { status?: FeedHealthState | undefined; channelId?: string | undefined; providerId?: string | undefined; offset: number; limit: number }): Promise<{ items: FeedHealthRecord[]; total: number }>;
  feedHealthOf(feedIds: string[]): Promise<Map<string, FeedHealthState>>;
  probeHistory(feedId: string, limit: number): Promise<ProbeResultRecord[]>;
  statusCounts(): Promise<Record<FeedHealthState, number>>;

  // failover
  /** Playable feeds of a channel with their health. */
  channelFeeds(channelId: string): Promise<ChannelFeedHealth[]>;
  /** The channel's failover row, locked (created when missing). */
  lockFailover(channelId: string): Promise<FailoverRecord>;
  saveFailover(record: FailoverRecord, now: Date): Promise<void>;
  failoverOf(channelId: string): Promise<FailoverRecord | null>;
  appendFailoverEvent(event: Omit<FailoverEventRecord, 'id'>): Promise<void>;
  failoverEvents(channelId: string, limit: number): Promise<FailoverEventRecord[]>;
  /** Channels that have at least one playable feed (periodic re-evaluation, e.g. fail-back). */
  channelsWithFeeds(): Promise<string[]>;

  // incidents
  /** Opens (or refreshes the open) incident of (kind, target); `created` = newly opened. */
  openIncident(input: Omit<IncidentRecord, 'status' | 'openedAt' | 'lastSeenAt' | 'acknowledgedAt' | 'acknowledgedBy' | 'resolvedAt' | 'resolvedBy'>, now: Date): Promise<{ incident: IncidentRecord; created: boolean }>;
  /** Resolves the live incident of (kind, target), if any. */
  resolveIncident(kind: IncidentKind, targetId: string, now: Date, by: string | null): Promise<IncidentRecord | null>;
  findIncident(id: string): Promise<IncidentRecord | null>;
  acknowledgeIncident(id: string, staffId: string, now: Date): Promise<IncidentRecord | null>;
  resolveIncidentById(id: string, staffId: string, now: Date): Promise<IncidentRecord | null>;
  listIncidents(query: { status?: IncidentStatus | 'live' | undefined; offset: number; limit: number }): Promise<{ items: IncidentRecord[]; total: number }>;
  openIncidentCounts(): Promise<Record<IncidentKind, number>>;
  /** Live incidents whose target is no longer in the playable catalog. */
  orphanIncidents(): Promise<IncidentRecord[]>;
  /** Alert side effect for one delivery channel, committed with the incident change (outbox). */
  enqueueAlert(channel: AlertChannel, payload: { incidentId: string; event: 'opened' | 'resolved' }, now: Date): Promise<void>;

  // telemetry
  recordTelemetry(subject: TelemetrySubject, bucket: Date, sample: { start?: { startupMs: number | null }; error?: boolean }): Promise<void>;
  telemetrySince(subject: TelemetrySubject, since: Date): Promise<TelemetryStats>;

  // retention
  prune(cutoffs: { probes: Date; telemetry: Date; failoverEvents: Date; incidents: Date }): Promise<{ probes: number; telemetry: number; failoverEvents: number; incidents: number }>;
}

/** Light reachability check of a BYO source's endpoint (never opens a stream). */
export interface SourceEndpointChecker {
  check(credential: SourceCredential, signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number | null; message: string | null }>;
}

/** Careful health checks of subscribers' own (BYO) sources. */
export interface SourceHealthRepository {
  /** Rows for synced sources of recently active accounts; returns how many were added. */
  ensureRows(activeSince: Date, now: Date): Promise<number>;
  claimDue(now: Date, owner: string, leaseUntil: Date): Promise<{ sourceId: string; checks: { ok: boolean; latencyMs: number | null; at: string }[] } | null>;
  complete(sourceId: string, owner: string, checks: { ok: boolean; latencyMs: number | null; at: string }[], nextAt: Date): Promise<void>;
}

/** Where incident alerts go; one outbox message per channel (a retry never re-sends elsewhere). */
export type AlertChannel = 'webhook' | 'slack' | 'email';
export const alertTopic = (channel: AlertChannel) => `alert.${channel}`;

/**
 * Opaque per-candidate token that playback events carry back, so client telemetry can be
 * attributed to a feed / BYO source without exposing ids or addresses.
 */
export interface TelemetryTokens {
  /** Bound to the playback session: a token is only accepted with events of that viewing. */
  issue(subject: TelemetrySubject, expiresAt: Date, sessionId: string): string;
  verify(token: string, sessionId: string, now: Date): TelemetrySubject | null;
}

/** Operational metrics (Prometheus). Implementations must never throw. */
export interface Metrics {
  probe(region: string, outcome: ProbeOutcome, durationMs: number): void;
  failover(reason: FailoverEventReason): void;
  incident(kind: IncidentKind, event: 'opened' | 'resolved'): void;
  telemetry(subjectType: TelemetrySubject['type'], kind: 'start' | 'error'): void;
  playbackPlan(kind: 'byo' | 'operator', result: 'ok' | 'error'): void;
}

export const NOOP_METRICS: Metrics = {
  probe: () => undefined,
  failover: () => undefined,
  incident: () => undefined,
  telemetry: () => undefined,
  playbackPlan: () => undefined,
};

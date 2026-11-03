// Stream health, failover and incidents (Phase 7) — console API (/admin/v1/monitoring).

export type FeedHealthState = 'HEALTHY' | 'UNHEALTHY' | 'GEO_BLOCKED' | 'NOT_ENTITLED' | 'MAINTENANCE' | 'PROVIDER_OUTAGE' | 'UNKNOWN';
export type ProbeOutcome = 'ok' | 'degraded' | 'stalled' | 'unreachable' | 'http_error' | 'geo_blocked' | 'not_entitled' | 'invalid_media';

export interface RegionHealthDto {
  region: string;
  state: 'HEALTHY' | 'UNHEALTHY' | 'GEO_BLOCKED' | 'NOT_ENTITLED' | 'UNKNOWN';
  /** Consecutive failed / good probes (hysteresis counters). */
  failures: number;
  successes: number;
  lastProbeAt: string | null;
  lastOkAt: string | null;
  lastOutcome: ProbeOutcome | null;
  lastError: string | null;
}

export interface FeedHealthDto {
  feedId: string;
  channelId: string;
  channelName: string;
  providerId: string;
  providerName: string;
  priority: number;
  feedStatus: 'active' | 'disabled';
  /** Overall state (regions combined by consensus). */
  status: FeedHealthState;
  since: string;
  maintenance: boolean;
  maintenanceNote: string | null;
  regions: RegionHealthDto[];
  /** Configured probe regions that have not probed this feed yet. */
  missingRegions: string[];
}

export interface FeedHealthPageDto {
  items: FeedHealthDto[];
  total: number;
  /** Probe regions this deployment expects. */
  regions: string[];
}

export interface ProbeResultDto {
  region: string;
  probedAt: string;
  kind: 'manifest' | 'segment' | 'stream' | 'decode';
  outcome: ProbeOutcome;
  httpStatus: number | null;
  ttfbMs: number | null;
  durationMs: number;
  bytes: number | null;
  mediaSequence: number | null;
  error: string | null;
}

export interface MaintenanceRequest {
  on: boolean;
  note?: string;
}

export interface FailoverEventDto {
  occurredAt: string;
  fromFeedId: string | null;
  toFeedId: string | null;
  reason: 'initial' | 'unhealthy' | 'failback' | 'pinned' | 'unpinned' | 'no_feed';
  /** null = automatic. */
  actorEmail: string | null;
  details: Record<string, unknown>;
}

export interface ChannelFailoverDto {
  channelId: string;
  channelName: string;
  activeFeedId: string | null;
  mode: 'auto' | 'pinned';
  pin: { feedId: string; until: string | null; by: string | null; note: string | null } | null;
  lastSwitchAt: string | null;
  feeds: { id: string; priority: number; health: FeedHealthState; active: boolean }[];
  /** Journal, newest first. */
  events: FailoverEventDto[];
}

export interface PinFeedRequest {
  feedId: string;
  /** ISO time; omitted = until released. */
  until?: string | null;
  note?: string;
}

export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

export interface IncidentDto {
  id: string;
  kind: 'feed_unhealthy' | 'channel_down' | 'provider_outage';
  severity: 'warning' | 'critical';
  status: IncidentStatus;
  targetType: 'feed' | 'channel' | 'provider';
  targetId: string;
  title: string;
  details: Record<string, unknown>;
  openedAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface IncidentPageDto {
  items: IncidentDto[];
  total: number;
}

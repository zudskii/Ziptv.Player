import type { GuideOrigin, HistoryContentType, ProfileKind, ProgressContentType } from '@ziptv/contracts';
import type { ListItemKind } from '../../../application/ports/user-state-repository.js';
import type { ColumnType, Generated } from 'kysely';

import type { CatalogStats, CatalogWarning, EpgLink, CatchupInfo, StreamKind, UnplayableReason } from '../../../domain/catalog/model.js';
import type { StaffRole } from '../../../domain/admin/rbac.js';
import type { UserRole } from '../../../domain/identity/credentials.js';
import type { HealthState, SourceProblem, SourceType, SyncStage, SyncStatus } from '../../../domain/sources/source.js';
import type { SourceOrigin } from '../../../application/ports/source-repository.js';
import type { StoredProfileSettings } from '../../../domain/viewer/settings.js';
import type { SubscriptionStatus } from '../../../domain/commerce/subscription.js';
import type { FeedHealthState, ProbeOutcome, RegionState } from '../../../domain/health/feed-health.js';
import type { FailoverEventReason, IncidentKind, IncidentStatus, ProbeStepKind } from '../../../application/ports/health.js';
import type { AliasKind, BusinessModel, DeviceClass, MatchMethod, ProviderStatus, ProviderType, StreamStatus } from '../../../domain/operator/catalog.js';

/**
 * Typed view of the database. This file is the single place where table and column names
 * exist as types; repositories cannot reference a column that is not declared here.
 *
 * JSON columns are read as parsed values and written as JSON strings (node-pg would turn a
 * JS array into a Postgres array, so JSON is always serialised explicitly).
 */
type Json<T> = ColumnType<T, string, string>;
type JsonDefault<T> = ColumnType<T, string | undefined, string>;
type NullableJson<T> = ColumnType<T | null, string | null | undefined, string | null>;

/** `Date` inside a jsonb value comes back as an ISO string. */
export interface StoredHealth {
  state: HealthState;
  checkedAt: string | null;
  latencyMs: number | null;
  /** Rows written before Phase 7 have no plays/failedPlays. */
  plays?: number;
  failedPlays?: number;
  message: string | null;
}

export interface StoredAccount {
  status: string;
  expiresAt: string | null;
  maxConnections: number | null;
  activeConnections: number | null;
  trial: boolean;
}

export interface UsersTable {
  id: string;
  /** Lower-cased. NULL (together with password_hash) = guest. */
  email: string | null;
  password_hash: string | null;
  role: Generated<UserRole>;
  email_verified_at: Date | null;
  legacy_secret_id: string | null;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  /** Staff blocked the account (no operator playback, no purchases). */
  blocked_at: Date | null;
  blocked_reason: string | null;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  token_hash: string;
  user_agent: string | null;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  /** NULL = never expires (guest sessions). */
  expires_at: Date | null;
  /** This device entered a kids profile: other profiles need the parental PIN. */
  kids_lock_profile_id: Generated<string | null>;
  /** The PIN-protected profile opened on this device with the PIN. */
  open_profile_id: Generated<string | null>;
}

export interface SourcesTable {
  id: string;
  owner_id: string;
  name: string;
  type: SourceType;
  origin: Json<SourceOrigin>;
  /** Encrypted `SourceCredential`; null for file sources. */
  credential: string | null;
  revision: Generated<number>;
  epg_version: Generated<number>;
  stats: JsonDefault<CatalogStats>;

  sync_status: SyncStatus;
  sync_stage: SyncStage | null;
  sync_auto: boolean;
  sync_interval_hours: number;
  sync_last_attempt_at: Date | null;
  sync_last_success_at: Date | null;
  sync_next_at: Date | null;
  sync_error: NullableJson<{ problem: SourceProblem; message: string }>;
  sync_failures: number;
  sync_rerun: boolean;
  lease_owner: string | null;
  lease_until: Date | null;

  health: JsonDefault<StoredHealth>;
  account: NullableJson<StoredAccount>;
  epg_urls: Generated<string[]>;
  warnings: JsonDefault<CatalogWarning[]>;
  warning_count: Generated<number>;
  format: Generated<string>;
  encoding: Generated<string>;
  xtream_candidate: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LiveChannelsTable {
  source_id: string;
  revision: number;
  key: string;
  position: number;
  name: string;
  groups: string[];
  logo: string | null;
  tvg_id: string | null;
  tvg_name: string | null;
  kind: StreamKind;
  unplayable_reason: UnplayableReason | null;
  /** Encrypted `StreamLocator`. */
  locator: string | null;
  catchup: NullableJson<CatchupInfo>;
  adult: boolean;
  xtream: NullableJson<{ id: number; epgChannelId: string | null }>;
  added_at: Date | null;
  epg: NullableJson<EpgLink>;
  name_key: string;
  search_tokens: string[];
  /** ' token token ' for LIKE '% term%' (pg_trgm index). */
  search: Generated<string>;
}

export interface MoviesTable {
  source_id: string;
  revision: number;
  key: string;
  position: number;
  name: string;
  year: number | null;
  groups: string[];
  poster: string | null;
  rating: number | null;
  genres: string[];
  duration_secs: number | null;
  plot: string | null;
  kind: StreamKind;
  locator: string | null;
  adult: boolean;
  xtream: NullableJson<{ id: number; ext: string }>;
  added_at: Date | null;
  search_tokens: string[];
  search: Generated<string>;
}

export interface SeriesTable {
  source_id: string;
  revision: number;
  key: string;
  position: number;
  name: string;
  year: number | null;
  groups: string[];
  cover: string | null;
  rating: number | null;
  genres: string[];
  plot: string | null;
  adult: boolean;
  xtream: NullableJson<{ id: number }>;
  added_at: Date | null;
  search_tokens: string[];
  search: Generated<string>;
  /** Xtream: when seasons/episodes were last loaded (lazily, on first open). */
  details_fetched_at: Date | null;
}

export interface EpisodesTable {
  source_id: string;
  revision: number;
  series_key: string;
  key: string;
  season: number;
  episode: number;
  title: string;
  plot: string | null;
  duration_secs: number | null;
  still: string | null;
  air_date: string | null;
  kind: StreamKind;
  locator: string | null;
  xtream: NullableJson<{ id: number; ext: string }>;
}

export interface NotificationsTable {
  id: string;
  owner_id: string;
  type: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string | null;
  link: string | null;
  read: Generated<boolean>;
  dedupe_key: string | null;
  created_at: Date;
}

export interface SchedulesTable {
  job: string;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_error: string | null;
  lease_owner: string | null;
  lease_until: Date | null;
}

export interface EmailTokensTable {
  id: string;
  user_id: string;
  purpose: 'verify_email' | 'reset_password';
  token_hash: string;
  email: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

export interface PlaylistsTable {
  id: string;
  owner_id: string;
  name: string;
  export_token_hash: string | null;
  export_token_sealed: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PlaylistGroupsTable {
  id: string;
  playlist_id: string;
  name: string;
  position: number;
}

export interface PlaylistEntriesTable {
  id: string;
  playlist_id: string;
  group_id: string | null;
  position: number;
  number: number | null;
  name: string;
  logo: string | null;
  tvg_id: string | null;
  source_id: string;
  source_key: string;
  origin_name_key: Generated<string>;
  created_at: Generated<Date>;
}

export interface StaffUsersTable {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: StaffRole;
  /** Encrypted (application cipher, purpose `staff-mfa`). */
  mfa_secret: string | null;
  mfa_enabled_at: Date | null;
  /** Last accepted TOTP time step (replay protection). bigint → string from node-pg. */
  mfa_last_step: ColumnType<string | null, number | null | undefined, number | null>;
  must_change_password: Generated<boolean>;
  /** Consecutive wrong TOTP codes; reaching the limit sets locked_until. */
  mfa_failures: Generated<number>;
  locked_until: Date | null;
  disabled_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface StaffSessionsTable {
  id: string;
  staff_id: string;
  token_hash: string;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
}

export interface AdminAuditLogsTable {
  seq: ColumnType<string, number, never>;
  occurred_at: Date;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before_hash: string | null;
  after_hash: string | null;
  details: Json<Record<string, unknown>>;
  ip: string | null;
  prev_hash: string;
  hash: string;
}

export interface OutboxTable {
  id: string;
  topic: string;
  payload: Json<Record<string, unknown>>;
  created_at: Date;
  available_at: Date;
  attempts: Generated<number>;
  last_error: string | null;
  processed_at: Date | null;
  lease_owner: string | null;
  lease_until: Date | null;
}

export interface StoredGuideStats {
  channels: number;
  keptChannels: number;
  programmes: number;
  from: string | null;
  to: string | null;
}

export interface GuidesTable {
  id: string;
  owner_id: string;
  name: string;
  origin: GuideOrigin;
  /** Encrypted XMLTV URL. */
  url: string;
  url_hash: string;
  host: Generated<string>;
  generation: Generated<number>;
  next_generation: Generated<number>;
  sync_status: Generated<'idle' | 'queued' | 'running' | 'failed'>;
  sync_last_attempt_at: Date | null;
  sync_last_success_at: Date | null;
  sync_next_at: Date | null;
  sync_error: string | null;
  sync_failures: Generated<number>;
  sync_rerun: Generated<boolean>;
  lease_owner: string | null;
  lease_until: Date | null;
  stats: JsonDefault<StoredGuideStats>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface GuideSourcesTable {
  guide_id: string;
  source_id: string;
}

export interface GuideChannelsTable {
  guide_id: string;
  generation: number;
  id: string;
  names: string[];
  icon: string | null;
  kept: boolean;
  search: string;
}

export interface ProgrammesTable {
  guide_id: string;
  generation: number;
  channel_id: string;
  start_at: Date;
  stop_at: Date;
  title: string;
  subtitle: string | null;
  description: string | null;
  categories: string[];
  icon: string | null;
  episode: string | null;
  rating: string | null;
  search: string;
}

export interface EpgMappingsTable {
  owner_id: string;
  source_id: string;
  channel_key: string;
  guide_id: string;
  epg_channel_id: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProfilesTable {
  id: string;
  user_id: string;
  name: string;
  color: string;
  kind: ProfileKind;
  is_default: Generated<boolean>;
  settings: JsonDefault<StoredProfileSettings>;
  pin_protected: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ParentalPinsTable {
  user_id: string;
  pin_hash: string;
  version: Generated<number>;
  failures: Generated<number>;
  locked_until: Date | null;
  updated_at: Generated<Date>;
}

export interface ParentalRulesTable {
  profile_id: string;
  hide_adult: Generated<boolean>;
  locked_groups: JsonDefault<{ sourceId: string; group: string }[]>;
  locked_channels: JsonDefault<{ sourceId: string; key: string; name: string }[]>;
  updated_at: Generated<Date>;
}

export interface ListItemsTable {
  profile_id: string;
  source_id: string;
  type: ListItemKind;
  key: string;
  title: string;
  subtitle: string | null;
  image: string | null;
  added_at: Generated<Date>;
}

export interface ProgressTable {
  profile_id: string;
  source_id: string;
  content_type: ProgressContentType;
  series_key: Generated<string>;
  key: string;
  season: number | null;
  episode: number | null;
  title: string;
  series_title: string | null;
  image: string | null;
  position: number;
  duration: number;
  completed: Generated<boolean>;
  updated_at: Generated<Date>;
}

export interface HistoryTable {
  id: string;
  profile_id: string;
  source_id: string | null;
  channel_id: string | null;
  content_type: HistoryContentType;
  key: string;
  series_key: string | null;
  season: number | null;
  episode: number | null;
  title: string;
  subtitle: string | null;
  series_title: string | null;
  image: string | null;
  started_at: Generated<Date>;
  watched_at: Generated<Date>;
  watched_secs: Generated<number>;
  programme_start: Date | null;
  programme_end: Date | null;
}

export interface ProvidersTable {
  id: string;
  slug: string;
  name: string;
  status: ProviderStatus;
  integration_type: ProviderType;
  config: JsonDefault<Record<string, unknown>>;
  host: Generated<string>;
  sync_interval_hours: Generated<number>;
  sync_status: Generated<SyncStatus>;
  sync_last_attempt_at: Date | null;
  sync_last_success_at: Date | null;
  sync_next_at: Date | null;
  sync_error: string | null;
  sync_failures: Generated<number>;
  lease_owner: string | null;
  lease_until: Date | null;
  stats: JsonDefault<{ streams: number; matched: number; pending: number; gone: number }>;
  contract_ref: string | null;
  contract_start_at: Date | null;
  contract_end_at: Date | null;
  /** numeric(5,2): read as a string by node-postgres. */
  sla_target_pct: ColumnType<string | null, number | null | undefined, number | null>;
  monthly_cost_minor: number | null;
  cost_currency: string | null;
  notes: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProviderCredentialsTable {
  provider_id: string;
  secret_ref: string;
  rotated_at: Generated<Date>;
}

export interface CategoriesTable {
  id: string;
  slug: string;
  name: string;
  created_at: Generated<Date>;
}

export interface ChannelMasterTable {
  id: string;
  slug: string;
  name: string;
  origin_country: string | null;
  languages: Generated<string[]>;
  category_id: string | null;
  logo: string | null;
  global_uid: string | null;
  status: Generated<'active' | 'hidden'>;
  search: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ChannelAliasesTable {
  kind: AliasKind;
  key: string;
  channel_id: string;
  created_at: Generated<Date>;
}

export interface ProviderStreamsTable {
  id: string;
  provider_id: string;
  external_id: string;
  name: string;
  tvg_id: string | null;
  groups: Generated<string[]>;
  logo: string | null;
  kind: StreamKind;
  locator: string | null;
  xtream: NullableJson<{ id: number }>;
  catchup: NullableJson<CatchupInfo>;
  status: Generated<StreamStatus>;
  channel_id: string | null;
  match_method: MatchMethod | null;
  suggestion: string | null;
  first_seen_at: Generated<Date>;
  last_seen_at: Generated<Date>;
}

export interface ChannelFeedsTable {
  id: string;
  channel_id: string;
  provider_id: string;
  provider_stream_id: string;
  priority: Generated<number>;
  delivery_mode: Generated<'proxy'>;
  status: Generated<'active' | 'disabled'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RightsGrantsTable {
  id: string;
  channel_id: string;
  territory: string;
  device_classes: DeviceClass[];
  business_models: BusinessModel[];
  start_at: Date;
  end_at: Date | null;
  contract_ref: string;
  catchup_days: Generated<number>;
  status: Generated<'active' | 'revoked'>;
  created_by: string | null;
  created_at: Generated<Date>;
  revoked_at: Date | null;
}

export interface LineupsTable {
  id: string;
  slug: string;
  name: string;
  country: string;
  status: Generated<'draft' | 'active'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LineupChannelsTable {
  lineup_id: string;
  channel_id: string;
  number: number;
}

export interface OperatorFavoritesTable {
  profile_id: string;
  channel_id: string;
  added_at: Generated<Date>;
}

export interface FeedProbeStateTable {
  feed_id: string;
  region: string;
  state: Generated<RegionState>;
  failures: Generated<number>;
  successes: Generated<number>;
  last_outcome: ProbeOutcome | null;
  last_error: string | null;
  last_probe_at: Date | null;
  last_ok_at: Date | null;
  next_probe_at: Generated<Date>;
  media_sequence: string | null;
  last_segment: string | null;
  sequence_at: Date | null;
  last_decode_at: Date | null;
  lease_owner: string | null;
  lease_until: Date | null;
}

export interface StreamProbeResultsTable {
  id: Generated<string>;
  feed_id: string;
  region: string;
  probed_at: Date;
  kind: ProbeStepKind;
  outcome: ProbeOutcome;
  http_status: number | null;
  ttfb_ms: number | null;
  duration_ms: number | null;
  bytes: number | null;
  media_sequence: string | null;
  error: string | null;
}

export interface FeedHealthTable {
  feed_id: string;
  status: Generated<FeedHealthState>;
  since: Generated<Date>;
  maintenance: Generated<boolean>;
  maintenance_note: string | null;
  updated_at: Generated<Date>;
}

export interface ChannelFailoverTable {
  channel_id: string;
  active_feed_id: string | null;
  pinned_feed_id: string | null;
  pinned_until: Date | null;
  pinned_by: string | null;
  pin_note: string | null;
  last_switch_at: Date | null;
  updated_at: Generated<Date>;
}

export interface FailoverEventsTable {
  id: Generated<string>;
  channel_id: string;
  occurred_at: Date;
  from_feed_id: string | null;
  to_feed_id: string | null;
  reason: FailoverEventReason;
  actor_id: string | null;
  actor_email: string | null;
  details: JsonDefault<Record<string, unknown>>;
}

export interface IncidentsTable {
  id: string;
  kind: IncidentKind;
  severity: 'warning' | 'critical';
  status: Generated<IncidentStatus>;
  target_type: 'feed' | 'channel' | 'provider';
  target_id: string;
  title: string;
  details: JsonDefault<Record<string, unknown>>;
  opened_at: Date;
  last_seen_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
}

export interface PlaybackTelemetryTable {
  subject_type: 'feed' | 'source';
  subject_id: string;
  bucket: Date;
  starts: Generated<number>;
  errors: Generated<number>;
  startup_ms_sum: Generated<string>;
  startup_count: Generated<number>;
}

export interface SourceProbeStateTable {
  source_id: string;
  next_check_at: Generated<Date>;
  checks: JsonDefault<{ ok: boolean; latencyMs: number | null; at: string }[]>;
  lease_owner: string | null;
  lease_until: Date | null;
}

export interface PackagesTable {
  id: string;
  slug: string;
  name: string;
  description: Generated<string>;
  price_minor: number;
  currency: string;
  billing_period: 'month' | 'year';
  trial_days: Generated<number>;
  max_devices: number;
  max_streams: number;
  business_model: Generated<'subscription' | 'b2b'>;
  status: Generated<'draft' | 'active' | 'retired'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PackageChannelsTable {
  package_id: string;
  channel_id: string;
}

export interface SubscriptionsTable {
  id: string;
  user_id: string;
  package_id: string;
  status: SubscriptionStatus;
  trial_ends_at: Date | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: Generated<boolean>;
  ended_at: Date | null;
  processor: string;
  processor_ref: string;
  reconciled_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EntitlementsTable {
  id: string;
  user_id: string;
  package_id: string;
  kind: 'subscription' | 'comp';
  subscription_id: string | null;
  starts_at: Date;
  ends_at: Date | null;
  revoked_at: Date | null;
  note: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DevicesTable {
  id: string;
  user_id: string;
  key_hash: string;
  name: string;
  platform: DeviceClass;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  revoked_at: Date | null;
}

export interface PlaybackSessionsTable {
  id: string;
  user_id: string;
  profile_id: string | null;
  device_id: string;
  channel_id: string;
  access: 'package' | 'fast' | 'rights';
  package_id: string | null;
  country: string | null;
  started_at: Date;
  last_heartbeat_at: Date;
  expires_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
  provider_id: string | null;
  archive_start: Date | null;
  archive_end: Date | null;
}

export interface CheckoutsTable {
  id: string;
  user_id: string;
  package_id: string;
  processor: string;
  processor_ref: string | null;
  with_trial: Generated<boolean>;
  status: Generated<'open' | 'completed' | 'expired'>;
  subscription_id: string | null;
  created_at: Generated<Date>;
  completed_at: Date | null;
}

export interface InvoicesTable {
  id: string;
  user_id: string;
  subscription_id: string;
  processor: string;
  processor_ref: string;
  amount_minor: number;
  currency: string;
  status: 'paid' | 'refunded';
  period_start: Date;
  period_end: Date;
  paid_at: Date;
  refunded_at: Date | null;
}

export interface PaymentEventsTable {
  id: string;
  processor: string;
  event_id: string;
  type: string;
  payload: Json<unknown>;
  received_at: Date;
  processed_at: Date | null;
  outcome: string | null;
}

export interface LeasesTable {
  key: string;
  holder: string;
  expires_at: Date;
}

export type ChangeRequestKind = 'package.create' | 'package.update' | 'rights.grant' | 'rights.revoke';
export type ChangeRequestStatus = 'pending' | 'applied' | 'rejected' | 'withdrawn' | 'failed' | 'reviewed';

export interface ChangeRequestsTable {
  id: string;
  kind: ChangeRequestKind;
  mode: 'approval' | 'review';
  status: ChangeRequestStatus;
  target_type: string;
  target_id: string | null;
  payload: ColumnType<Record<string, unknown>, string, string>;
  summary: string;
  base_hash: string | null;
  requested_by: string;
  requested_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  error: string | null;
}

export interface SupportNotesTable {
  id: string;
  user_id: string;
  author_id: string;
  body: string;
  created_at: Date;
}

export interface OperatorGuidesTable {
  id: string;
  name: string;
  url: string;
  url_hash: string;
  host: Generated<string>;
  status: Generated<'active' | 'paused'>;
  priority: Generated<number>;
  generation: Generated<number>;
  next_generation: Generated<number>;
  sync_rerun: Generated<boolean>;
  sync_interval_hours: Generated<number>;
  sync_status: Generated<SyncStatus>;
  sync_last_attempt_at: Date | null;
  sync_last_success_at: Date | null;
  sync_next_at: Date | null;
  sync_error: string | null;
  sync_failures: Generated<number>;
  lease_owner: string | null;
  lease_until: Date | null;
  stats: JsonDefault<{ channels: number; programmes: number; from: string | null; to: string | null }>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OperatorGuideChannelsTable {
  guide_id: string;
  generation: number;
  id: string;
  names: string[];
  icon: string | null;
}

export interface OperatorProgrammesTable {
  guide_id: string;
  generation: number;
  epg_channel_id: string;
  start_at: Date;
  stop_at: Date;
  title: string;
  subtitle: string | null;
  description: string | null;
  categories: string[];
  icon: string | null;
}

export interface ChannelEpgTable {
  channel_id: string;
  guide_id: string;
  epg_channel_id: string;
  method: 'auto' | 'manual';
  updated_at: Date;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  parental_pins: ParentalPinsTable;
  parental_rules: ParentalRulesTable;
  email_tokens: EmailTokensTable;
  sources: SourcesTable;
  live_channels: LiveChannelsTable;
  movies: MoviesTable;
  series: SeriesTable;
  episodes: EpisodesTable;
  playlists: PlaylistsTable;
  playlist_groups: PlaylistGroupsTable;
  playlist_entries: PlaylistEntriesTable;
  notifications: NotificationsTable;
  schedules: SchedulesTable;
  staff_users: StaffUsersTable;
  staff_sessions: StaffSessionsTable;
  admin_audit_logs: AdminAuditLogsTable;
  outbox: OutboxTable;
  guides: GuidesTable;
  guide_sources: GuideSourcesTable;
  guide_channels: GuideChannelsTable;
  programmes: ProgrammesTable;
  epg_mappings: EpgMappingsTable;
  profiles: ProfilesTable;
  list_items: ListItemsTable;
  progress: ProgressTable;
  history: HistoryTable;
  providers: ProvidersTable;
  provider_credentials: ProviderCredentialsTable;
  categories: CategoriesTable;
  channel_master: ChannelMasterTable;
  channel_aliases: ChannelAliasesTable;
  provider_streams: ProviderStreamsTable;
  channel_feeds: ChannelFeedsTable;
  rights_grants: RightsGrantsTable;
  lineups: LineupsTable;
  lineup_channels: LineupChannelsTable;
  operator_favorites: OperatorFavoritesTable;
  feed_probe_state: FeedProbeStateTable;
  stream_probe_results: StreamProbeResultsTable;
  feed_health: FeedHealthTable;
  channel_failover: ChannelFailoverTable;
  failover_events: FailoverEventsTable;
  incidents: IncidentsTable;
  playback_telemetry: PlaybackTelemetryTable;
  source_probe_state: SourceProbeStateTable;
  packages: PackagesTable;
  package_channels: PackageChannelsTable;
  subscriptions: SubscriptionsTable;
  entitlements: EntitlementsTable;
  devices: DevicesTable;
  playback_sessions: PlaybackSessionsTable;
  checkouts: CheckoutsTable;
  invoices: InvoicesTable;
  payment_events: PaymentEventsTable;
  leases: LeasesTable;
  change_requests: ChangeRequestsTable;
  support_notes: SupportNotesTable;
  operator_guides: OperatorGuidesTable;
  operator_guide_channels: OperatorGuideChannelsTable;
  operator_programmes: OperatorProgrammesTable;
  channel_epg: ChannelEpgTable;
}

/** Serialises a value for a JSON column. */
export function json<T>(value: T): string {
  return JSON.stringify(value);
}

export function jsonOrNull<T>(value: T | null | undefined): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

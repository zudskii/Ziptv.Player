import type { GuideOrigin } from '@ziptv/contracts';
import type { ColumnType, Generated } from 'kysely';

import type { CatalogStats, CatalogWarning, EpgLink, CatchupInfo, StreamKind, UnplayableReason } from '../../../domain/catalog/model.js';
import type { StaffRole } from '../../../domain/admin/rbac.js';
import type { UserRole } from '../../../domain/identity/credentials.js';
import type { HealthState, SourceProblem, SourceType, SyncStage, SyncStatus } from '../../../domain/sources/source.js';
import type { SourceOrigin } from '../../../application/ports/source-repository.js';

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
  unstableStreams: number;
  offlineStreams: number;
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

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
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
}

/** Serialises a value for a JSON column. */
export function json<T>(value: T): string {
  return JSON.stringify(value);
}

export function jsonOrNull<T>(value: T | null | undefined): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

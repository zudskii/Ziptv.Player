import type { ColumnType, Generated } from 'kysely';

import type { CatalogStats, CatalogWarning, EpgLink, CatchupInfo, StreamKind, UnplayableReason } from '../../../domain/catalog/model.js';
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

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  sources: SourcesTable;
  live_channels: LiveChannelsTable;
  movies: MoviesTable;
  series: SeriesTable;
  episodes: EpisodesTable;
  notifications: NotificationsTable;
  schedules: SchedulesTable;
}

/** Serialises a value for a JSON column. */
export function json<T>(value: T): string {
  return JSON.stringify(value);
}

export function jsonOrNull<T>(value: T | null | undefined): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

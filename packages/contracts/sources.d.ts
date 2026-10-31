import type { HealthState, ParseWarningDto } from './common';

// ---------------------------------------------------------------------------
// Sources — a user's content providers (M3U URL, M3U file, Xtream Codes API).
// One source feeds Live TV, Movies and Series; ZIPTV syncs it in the background.
// ---------------------------------------------------------------------------

export type SourceType = 'm3u_url' | 'm3u_file' | 'xtream';

export type SourceSyncStatus = 'idle' | 'queued' | 'running' | 'failed';

/** Progress of a running sync, in the order the onboarding screen shows them. */
export type SourceSyncStage = 'connecting' | 'parsing' | 'matching_epg' | 'building_library';

/** Why the last sync failed — each maps to its own UX (re-enter credentials, renew, retry…). */
export type SourceProblem =
  | 'auth_failed'
  | 'expired'
  | 'unavailable'
  | 'invalid'
  | 'empty'
  | 'too_large'
  | 'blocked'
  | 'unknown';

export interface SourceSyncDto {
  status: SourceSyncStatus;
  stage: SourceSyncStage | null;
  autoSync: boolean;
  /** Hours between automatic syncs. */
  intervalHours: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextSyncAt: string | null;
  error: { problem: SourceProblem; message: string } | null;
}

export interface SourceStatsDto {
  live: number;
  movies: number;
  series: number;
  /** Episodes known so far (Xtream series are loaded on demand). */
  episodes: number;
  groups: number;
  unplayable: number;
  /** Live channels with catch-up/archive. */
  catchup: number;
  /** Live channels linked to a guide (EPG). */
  epgMapped: number;
}

export interface SourceHealthDto {
  state: HealthState;
  checkedAt: string | null;
  /** Latency of the last reachability check of the provider. */
  latencyMs: number | null;
  /** Streams that recently failed / were flaky in real playback or a sample check. */
  unstableStreams: number;
  offlineStreams: number;
  message: string | null;
}

/** Xtream account information (`player_api.php` user_info). */
export interface SourceAccountDto {
  status: string;
  expiresAt: string | null;
  maxConnections: number | null;
  activeConnections: number | null;
  trial: boolean;
}

/** Where the content comes from — never contains passwords or tokenised URLs. */
export type SourceOriginDto =
  | { kind: 'url'; host: string }
  | { kind: 'file'; fileName: string }
  | { kind: 'xtream'; host: string; username: string };

export interface SourceDto {
  id: string;
  name: string;
  type: SourceType;
  origin: SourceOriginDto;
  /** Increments on every successful sync. */
  revision: number;
  /**
   * Cache key of everything derived from this source (catalog revision + guide links).
   * Changes whenever channel lists, now/next links or the library change.
   */
  catalogVersion: string;
  sync: SourceSyncDto;
  stats: SourceStatsDto;
  health: SourceHealthDto;
  account: SourceAccountDto | null;
  /** Guides (XMLTV) attached to this source. */
  epg: {
    guides: number;
    /** Changes whenever one of the source's guides loaded new programmes (cache key of now/next, schedules). */
    version: string;
    /** A guide of this source is being (re)loaded. */
    syncing: boolean;
  };
  /** First N parser warnings of the latest import. */
  warnings: ParseWarningDto[];
  warningCount: number;
  /** This M3U URL is an Xtream panel — it can be converted to an Xtream source (Movies/Series/archive). */
  xtreamCandidate: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AddSourceRequest =
  | { type: 'm3u_url'; url: string; name?: string }
  | { type: 'xtream'; server: string; username: string; password: string; name?: string };

export interface UpdateSourceRequest {
  name?: string;
  autoSync?: boolean;
  intervalHours?: number;
  /** m3u_url only: replace the playlist URL. */
  url?: string;
  /** xtream only: replace the credentials. */
  xtream?: { server: string; username: string; password: string };
}

export interface SourceHealthCheckDto {
  source: SourceDto;
  checked: number;
  failed: number;
}

/**
 * Source domain rules: types, sync scheduling, failure classification and health.
 *
 *   Source ─ SourceType (m3u_url | m3u_file | xtream)
 *          ─ SourceCredential   (encrypted: playlist URL or Xtream server/user/password)
 *          ─ SourceSyncState    (status, stage, schedule, last error)
 *          ─ SourceHealth       (online / slow / unstable / offline)
 */

export type SourceType = 'm3u_url' | 'm3u_file' | 'xtream';

export type SyncStatus = 'idle' | 'queued' | 'running' | 'failed';

export type SyncStage = 'connecting' | 'parsing' | 'matching_epg' | 'building_library';

export type SourceProblem = 'auth_failed' | 'expired' | 'unavailable' | 'invalid' | 'empty' | 'too_large' | 'blocked' | 'unknown';

export type HealthState = 'online' | 'slow' | 'unstable' | 'offline' | 'unknown';

/** Decrypted credential. Never logged, never returned by the API. */
export type SourceCredential =
  | { type: 'm3u_url'; url: string }
  | { type: 'xtream'; server: string; username: string; password: string };

export const DEFAULT_SYNC_INTERVAL_HOURS = 6;
export const MIN_SYNC_INTERVAL_HOURS = 1;
export const MAX_SYNC_INTERVAL_HOURS = 168;

/** Uploaded files have nothing to re-download; they change only when the user replaces the file. */
export function isSyncable(type: SourceType): boolean {
  return type !== 'm3u_file';
}

/**
 * When to sync next.
 * Success: one interval later. Failure: exponential backoff (15 min, 30, 60 …) capped at the
 * interval, so a provider outage is retried soon without hammering it every minute.
 */
export function nextSyncAt(input: { type: SourceType; autoSync: boolean; intervalHours: number; now: Date; consecutiveFailures: number }): Date | null {
  if (!isSyncable(input.type) || !input.autoSync) return null;
  const intervalMs = clampInterval(input.intervalHours) * 3600_000;
  if (input.consecutiveFailures <= 0) return new Date(input.now.getTime() + intervalMs);
  const backoffMs = Math.min(intervalMs, 15 * 60_000 * 2 ** Math.min(input.consecutiveFailures - 1, 8));
  return new Date(input.now.getTime() + backoffMs);
}

export function clampInterval(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULT_SYNC_INTERVAL_HOURS;
  return Math.min(MAX_SYNC_INTERVAL_HOURS, Math.max(MIN_SYNC_INTERVAL_HOURS, Math.round(hours)));
}

/**
 * Failure classification of a playlist download by HTTP status.
 * IPTV panels answer an expired/invalid subscription with 401/403, and a revoked playlist
 * link with 404/410 — each gets its own UX ("Authentication failed" vs "Playlist expired").
 */
export function problemFromHttpStatus(status: number): SourceProblem {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404 || status === 410) return 'expired';
  if (status === 429 || status >= 500) return 'unavailable';
  return 'unavailable';
}

/** Xtream `user_info.status` / expiry → problem (null = account usable). */
export function problemFromAccount(account: { status: string; expiresAt: Date | null }, now: Date): SourceProblem | null {
  const status = account.status.trim().toLowerCase();
  if (status === 'expired' || (account.expiresAt && account.expiresAt.getTime() < now.getTime())) return 'expired';
  if (status === 'banned' || status === 'disabled') return 'auth_failed';
  return null;
}

export interface HealthInput {
  reachable: boolean;
  latencyMs: number | null;
  /** Streams that failed in recent real playback or a sample probe. */
  offlineStreams: number;
  unstableStreams: number;
  /** Streams checked in the sample (0 = none checked). */
  sampled: number;
}

const SLOW_LATENCY_MS = 2_500;

/**
 * Source health from a reachability check plus stream telemetry.
 *  offline  — the provider itself does not answer
 *  unstable — streams fail/flap (≥ 1 failing in the sample or in real playback)
 *  slow     — answers, but slowly
 *  online   — everything fine
 */
export function evaluateHealth(input: HealthInput): HealthState {
  if (!input.reachable) return 'offline';
  if (input.sampled > 0 && input.offlineStreams >= input.sampled) return 'offline';
  if (input.offlineStreams > 0 || input.unstableStreams > 0) return 'unstable';
  if (input.latencyMs !== null && input.latencyMs > SLOW_LATENCY_MS) return 'slow';
  return 'online';
}

/** Hides credentials when showing an Xtream username (`zurab123` → `zu•••23`). */
export function maskUsername(username: string): string {
  if (username.length <= 4) return `${username.slice(0, 1)}•••`;
  return `${username.slice(0, 2)}•••${username.slice(-2)}`;
}

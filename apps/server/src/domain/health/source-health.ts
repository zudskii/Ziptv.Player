/**
 * Health of a subscriber's own source (BYO), shown next to it: Online / Slow / Unstable / Offline.
 *
 * Probing is deliberately careful: many IPTV accounts allow one or two concurrent connections,
 * so ZIPTV never opens a stream to check a source. Evidence is (a) a light check of the source's
 * endpoint (playlist headers / Xtream account call) at a low rate, and (b) what real playback
 * reported (starts, errors, startup time).
 */

import type { HealthState } from '../sources/source.js';

export type SourceHealth = HealthState;

export interface EndpointCheck {
  ok: boolean;
  latencyMs: number | null;
}

export interface PlaybackStats {
  starts: number;
  errors: number;
  /** Average time to first frame of successful starts. */
  avgStartupMs: number | null;
}

export interface SourceHealthPolicy {
  /** Consecutive failed checks for Offline. */
  offlineAfter: number;
  slowLatencyMs: number;
  slowStartupMs: number;
  /** Error share of playback attempts for Unstable … */
  unstableErrorRatio: number;
  /** … with at least this many attempts. */
  minAttempts: number;
}

export const DEFAULT_SOURCE_HEALTH_POLICY: SourceHealthPolicy = { offlineAfter: 2, slowLatencyMs: 3_000, slowStartupMs: 6_000, unstableErrorRatio: 0.3, minAttempts: 5 };

/** `checks` newest first. */
export function classifySourceHealth(checks: readonly EndpointCheck[], playback: PlaybackStats, policy: SourceHealthPolicy = DEFAULT_SOURCE_HEALTH_POLICY): SourceHealth {
  const attempts = playback.starts + playback.errors;
  if (checks.length === 0 && attempts === 0) return 'unknown';

  const recent = checks.slice(0, policy.offlineAfter);
  if (recent.length >= policy.offlineAfter && recent.every((check) => !check.ok)) return 'offline';

  const errorRatio = attempts >= policy.minAttempts ? playback.errors / attempts : 0;
  const flapping = checks.slice(0, 5).filter((check) => !check.ok).length >= 2;
  if (errorRatio >= policy.unstableErrorRatio || flapping) return 'unstable';

  const latest = checks[0];
  if ((latest?.ok && latest.latencyMs !== null && latest.latencyMs > policy.slowLatencyMs) || (playback.avgStartupMs !== null && playback.avgStartupMs > policy.slowStartupMs)) return 'slow';
  return latest && !latest.ok ? 'unstable' : 'online';
}

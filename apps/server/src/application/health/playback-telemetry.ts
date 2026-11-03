import type { PlaybackEventRequest } from '@ziptv/contracts';

import type { Cache } from '../ports/cache.js';
import type { Clock } from '../ports/clock.js';
import type { HealthRepository, Metrics, TelemetrySubject, TelemetryTokens } from '../ports/health.js';
import type { Logger } from '../ports/logger.js';

const BUCKET_MS = 5 * 60_000;
/** A player retries; a handful of errors per candidate and viewing is signal, more is noise. */
const MAX_ERRORS_PER_VIEWING = 3;

export interface TelemetryAlarmPolicy {
  windowMs: number;
  minAttempts: number;
  errorRatio: number;
  /** At most one re-probe request per feed per this long. */
  cooldownMs: number;
}

export const DEFAULT_TELEMETRY_ALARM: TelemetryAlarmPolicy = { windowMs: 15 * 60_000, minAttempts: 5, errorRatio: 0.5, cooldownMs: 10 * 60_000 };

/**
 * Real playback as a health signal: each candidate carries an opaque token; the client echoes it
 * with `start` (time to first frame) and `error` events. Counts land in 5-minute buckets per
 * feed / BYO source.
 *
 * Telemetry is reported by clients, so it can be wrong or forged: it never switches a feed by
 * itself. When many viewers fail on a feed, the feed is re-probed at once (every region) and the
 * probes — not the reports — decide.
 */
export class PlaybackTelemetry {
  constructor(
    private readonly deps: {
      tokens: TelemetryTokens;
      health: Pick<HealthRepository, 'recordTelemetry' | 'telemetrySince' | 'requestProbe'>;
      cache: Cache;
      clock: Clock;
      metrics: Metrics;
      logger: Logger;
      alarm?: TelemetryAlarmPolicy;
    },
  ) {}

  token(subject: TelemetrySubject, expiresAt: Date, sessionId: string): string {
    return this.deps.tokens.issue(subject, expiresAt, sessionId);
  }

  async record(event: PlaybackEventRequest): Promise<void> {
    if (!event.telemetry) return;
    const isStart = event.type === 'start' && event.startupMs !== undefined;
    if (!isStart && event.type !== 'error') return;
    const now = this.deps.clock.now();
    const subject = this.deps.tokens.verify(event.telemetry, event.sessionId, now);
    if (!subject) return;
    // One start and a few errors per candidate per viewing count (replays cannot inflate a feed).
    const dedupe = `telemetry-seen:${event.sessionId}:${event.telemetry}:${event.type}`;
    const seen = this.deps.cache.get<number>(dedupe) ?? 0;
    if (seen >= (isStart ? 1 : MAX_ERRORS_PER_VIEWING)) return;
    this.deps.cache.set(dedupe, seen + 1, 6 * 3600_000);
    try {
      const bucket = new Date(Math.floor(now.getTime() / BUCKET_MS) * BUCKET_MS);
      await this.deps.health.recordTelemetry(subject, bucket, isStart ? { start: { startupMs: event.startupMs ?? null } } : { error: true });
      this.deps.metrics.telemetry(subject.type, isStart ? 'start' : 'error');
      if (subject.type === 'feed' && !isStart) await this.checkAlarm(subject, now);
    } catch (error) {
      // Telemetry is best-effort; the viewer's request must not fail because of it.
      this.deps.logger.warn({ err: error, subject }, 'Recording playback telemetry failed');
    }
  }

  private async checkAlarm(subject: TelemetrySubject, now: Date): Promise<void> {
    const policy = this.deps.alarm ?? DEFAULT_TELEMETRY_ALARM;
    const key = `telemetry-alarm:${subject.id}`;
    if (this.deps.cache.get(key)) return;
    const stats = await this.deps.health.telemetrySince(subject, new Date(now.getTime() - policy.windowMs));
    const attempts = stats.starts + stats.errors;
    if (attempts < policy.minAttempts || stats.errors / attempts < policy.errorRatio) return;
    this.deps.cache.set(key, true, policy.cooldownMs);
    await this.deps.health.requestProbe(subject.id, now);
    this.deps.logger.warn({ feedId: subject.id, starts: stats.starts, errors: stats.errors }, 'Viewers report playback failures: feed re-probed');
  }
}

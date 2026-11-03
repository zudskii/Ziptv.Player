import { classifySourceHealth, type EndpointCheck } from '../../domain/health/source-health.js';
import type { TaskLease, Worker } from '../jobs/job-runner.js';
import type { Clock } from '../ports/clock.js';
import type { HealthRepository, SourceEndpointChecker, SourceHealthRepository } from '../ports/health.js';
import type { Logger } from '../ports/logger.js';
import type { SourceRepository } from '../ports/source-repository.js';
import type { SourceSecrets } from '../sources/secrets.js';

export const SOURCE_HEALTH_JOB = 'source-health';
const TELEMETRY_WINDOW_MS = 6 * 3600_000;
const ACTIVE_ACCOUNT_DAYS = 7;

type StoredCheck = { ok: boolean; latencyMs: number | null; at: string };

/**
 * Online / Slow / Unstable / Offline for subscribers' own sources: a light endpoint check at a
 * low rate (backing off while a source is offline) plus what real playback reported.
 */
export class SourceHealthService {
  constructor(
    private readonly deps: {
      sources: Pick<SourceRepository, 'findById' | 'updateHealth'>;
      secrets: Pick<SourceSecrets, 'openCredential'>;
      checker: SourceEndpointChecker;
      repository: SourceHealthRepository;
      telemetry: Pick<HealthRepository, 'telemetrySince'>;
      clock: Clock;
      logger: Logger;
      intervalMs: number;
      /** The source's cached views changed. */
      onChange?: (sourceId: string) => void;
    },
  ) {}

  async run(task: { sourceId: string; checks: StoredCheck[] }, lease: TaskLease): Promise<void> {
    const { clock, intervalMs } = this.deps;
    const source = await this.deps.sources.findById(task.sourceId);
    if (!source || !source.credential || source.type === 'm3u_file') {
      await this.deps.repository.complete(task.sourceId, lease.owner, task.checks, new Date(clock.now().getTime() + 24 * 3600_000));
      return;
    }
    const result = await this.deps.checker.check(this.deps.secrets.openCredential(source.credential), lease.signal);
    if (lease.signal.aborted) return;
    const now = clock.now();
    const checks: StoredCheck[] = [{ ok: result.ok, latencyMs: result.latencyMs, at: now.toISOString() }, ...task.checks].slice(0, 5);
    const playback = await this.deps.telemetry.telemetrySince({ type: 'source', id: source.id }, new Date(now.getTime() - TELEMETRY_WINDOW_MS));
    const state = classifySourceHealth(checks as EndpointCheck[], playback);
    await this.deps.sources.updateHealth(source.id, {
      state,
      checkedAt: now,
      latencyMs: result.latencyMs,
      plays: playback.starts + playback.errors,
      failedPlays: playback.errors,
      message: result.message,
    });
    // Offline sources are checked less often (no point hammering a dead or blocking provider).
    const next = state === 'offline' ? intervalMs * 4 : intervalMs;
    await this.deps.repository.complete(source.id, lease.owner, checks, new Date(now.getTime() + next));
    if (state !== source.health.state) {
      this.deps.logger.info({ sourceId: source.id, from: source.health.state, to: state }, 'Source health changed');
      this.deps.onChange?.(source.id);
    }
  }
}

export function createSourceHealthWorker(deps: { repository: SourceHealthRepository; service: SourceHealthService; clock: Clock; logger: Logger }): Worker {
  let ensuredAt = 0;
  return {
    name: SOURCE_HEALTH_JOB,
    pollIntervalMs: 30_000,
    concurrency: 2,
    leaseMs: 60_000,
    claim: async (owner, now, leaseUntil) => {
      if (now.getTime() - ensuredAt > 5 * 60_000) {
        ensuredAt = now.getTime();
        await deps.repository.ensureRows(new Date(now.getTime() - ACTIVE_ACCOUNT_DAYS * 86_400_000), now);
      }
      const task = await deps.repository.claimDue(now, owner, leaseUntil);
      if (!task) return null;
      return {
        label: `source-health:${task.sourceId}`,
        heartbeat: async () => true,
        run: (lease) => deps.service.run(task, lease),
      };
    },
  };
}

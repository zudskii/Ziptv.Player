import type { Worker } from '../jobs/job-runner.js';
import type { SourceRepository } from '../ports/source-repository.js';
import { SOURCE_SYNC_JOB } from './source.service.js';
import type { SourceSyncPipeline } from './source-sync.pipeline.js';

/**
 * SourceSyncWorker: picks sources that are queued ("Sync now", just added) or due
 * (every 6 h by default) and runs the sync pipeline for each under a lease.
 */
export function createSourceSyncWorker(deps: {
  sources: SourceRepository;
  pipeline: SourceSyncPipeline;
  concurrency: number;
  pollIntervalMs?: number;
}): Worker {
  return {
    name: SOURCE_SYNC_JOB,
    pollIntervalMs: deps.pollIntervalMs ?? 30_000,
    concurrency: deps.concurrency,
    leaseMs: 2 * 60_000,
    claim: async (owner, now, leaseUntil) => {
      const source = await deps.sources.claimDue(now, owner, leaseUntil);
      if (!source) return null;
      return {
        label: `source:${source.id}`,
        heartbeat: (leaseOwner, until) => deps.sources.heartbeat(source.id, leaseOwner, until),
        run: async (lease) => {
          await deps.pipeline.run(source, lease);
        },
      };
    },
  };
}

import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

import type { JobKicker } from '../sources/hooks.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { ScheduleRepository } from '../ports/schedule-repository.js';

export interface TaskLease {
  owner: string;
  signal: AbortSignal;
}

/** A unit of work claimed from the database under a lease. */
export interface ClaimedTask {
  /** For logs. */
  label: string;
  run(lease: TaskLease): Promise<void>;
  /** Extends the lease; false = lost (another instance took it over) → the task is aborted. */
  heartbeat(owner: string, leaseUntil: Date): Promise<boolean>;
}

export interface Worker {
  name: string;
  /** How often to look for work when idle. */
  pollIntervalMs: number;
  /** Parallel tasks of this worker per instance. */
  concurrency: number;
  leaseMs: number;
  claim(owner: string, now: Date, leaseUntil: Date): Promise<ClaimedTask | null>;
}

/**
 * Background job runner (SourceSyncWorker, EpgSyncWorker, MetadataSyncWorker, CleanupWorker…).
 *
 * Work is claimed from the database with leases, so any number of instances can run workers:
 * a task belongs to exactly one instance at a time, a crashed instance's lease simply expires,
 * and leases are extended by heartbeats while a long task (a 50 MB playlist) runs.
 */
export class JobRunner implements JobKicker {
  readonly owner = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  private readonly states = new Map<string, { worker: Worker; timer: ReturnType<typeof setTimeout> | null; active: Set<Promise<void>>; ticking: boolean }>();
  private readonly controllers = new Set<AbortController>();
  private running = false;

  constructor(
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  register(...workers: Worker[]): this {
    for (const worker of workers) {
      if (this.states.has(worker.name)) throw new Error(`Worker ${worker.name} is already registered`);
      this.states.set(worker.name, { worker, timer: null, active: new Set(), ticking: false });
      if (this.running) this.schedule(worker.name, 0);
    }
    return this;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const name of this.states.keys()) this.schedule(name, 1_000 + Math.floor(Math.random() * 2_000));
    this.logger.info({ owner: this.owner, workers: [...this.states.keys()] }, 'Background jobs started');
  }

  /** Look for work now (e.g. right after a user added a source). */
  kick(name: string): void {
    if (this.running && this.states.has(name)) this.schedule(name, 0);
  }

  /** Stops claiming; waits for running tasks up to `graceMs`, then aborts them. */
  async stop(graceMs = 10_000): Promise<void> {
    this.running = false;
    const active: Promise<void>[] = [];
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      active.push(...state.active);
    }
    if (active.length === 0) return;
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), graceMs).unref());
    if ((await Promise.race([Promise.allSettled(active), timeout])) === 'timeout') {
      for (const controller of this.controllers) controller.abort(new Error('Shutting down'));
      await Promise.allSettled(active);
    }
  }

  private schedule(name: string, delayMs: number): void {
    const state = this.states.get(name);
    if (!state || !this.running) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void this.tick(name), delayMs);
    state.timer.unref?.();
  }

  private async tick(name: string): Promise<void> {
    const state = this.states.get(name);
    if (!state || !this.running) return;
    state.timer = null;
    if (state.ticking) return;
    state.ticking = true;
    const { worker } = state;
    try {
      while (this.running && state.active.size < worker.concurrency) {
        const now = this.clock.now();
        const task = await worker.claim(this.owner, now, new Date(now.getTime() + worker.leaseMs));
        if (!task) break;
        const execution = this.execute(worker, task).finally(() => {
          state.active.delete(execution);
          this.schedule(name, 0); // there may be more queued work
        });
        state.active.add(execution);
      }
    } catch (error) {
      this.logger.error({ err: error, worker: name }, 'Job claim failed');
    } finally {
      state.ticking = false;
      if (this.running && !state.timer) this.schedule(name, worker.pollIntervalMs);
    }
  }

  private async execute(worker: Worker, task: ClaimedTask): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const heartbeat = setInterval(() => {
      const until = new Date(this.clock.now().getTime() + worker.leaseMs);
      task.heartbeat(this.owner, until).then(
        (kept) => {
          if (!kept) controller.abort(new Error('Lease lost'));
        },
        (error: unknown) => this.logger.warn({ err: error, task: task.label }, 'Lease heartbeat failed'),
      );
    }, Math.max(1_000, Math.floor(worker.leaseMs / 3)));
    heartbeat.unref?.();

    const started = Date.now();
    try {
      await task.run({ owner: this.owner, signal: controller.signal });
      this.logger.debug({ worker: worker.name, task: task.label, ms: Date.now() - started }, 'Job finished');
    } catch (error) {
      this.logger.error({ err: error, worker: worker.name, task: task.label }, 'Job failed');
    } finally {
      clearInterval(heartbeat);
      this.controllers.delete(controller);
    }
  }
}

/**
 * A job that must run once per interval across all instances (cleanup, metadata refresh,
 * health checks) — coordinated through the schedules collection.
 */
export function periodicWorker(input: {
  name: string;
  intervalMs: number;
  schedules: ScheduleRepository;
  leaseMs?: number;
  pollIntervalMs?: number;
  run: (lease: TaskLease) => Promise<void>;
}): Worker {
  const leaseMs = input.leaseMs ?? 10 * 60_000;
  return {
    name: input.name,
    pollIntervalMs: input.pollIntervalMs ?? Math.min(input.intervalMs, 5 * 60_000),
    concurrency: 1,
    leaseMs,
    claim: async (owner, now) => {
      const claimed = await input.schedules.claim(input.name, owner, now, input.intervalMs, leaseMs);
      if (!claimed) return null;
      return {
        label: input.name,
        heartbeat: async () => true,
        run: async (lease) => {
          try {
            await input.run(lease);
            await input.schedules.release(input.name, lease.owner, { ok: true });
          } catch (error) {
            await input.schedules.release(input.name, lease.owner, { ok: false, error: error instanceof Error ? error.message : String(error) });
            throw error;
          }
        },
      };
    },
  };
}

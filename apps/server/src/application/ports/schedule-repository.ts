/** Singleton periodic jobs (cleanup, metadata refresh, health checks) across instances. */
export interface ScheduleRepository {
  /**
   * Claims `job` when it is due and not leased by another instance; on success the next run
   * is scheduled `intervalMs` later. Returns false when someone else has it / it is not due.
   */
  claim(job: string, owner: string, now: Date, intervalMs: number, leaseMs: number): Promise<boolean>;
  release(job: string, owner: string, outcome: { ok: boolean; error?: string }): Promise<void>;
}

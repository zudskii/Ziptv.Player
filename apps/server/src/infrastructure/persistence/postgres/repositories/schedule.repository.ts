import type { ScheduleRepository } from '../../../../application/ports/schedule-repository.js';
import type { Db } from '../database.js';

export class PgScheduleRepository implements ScheduleRepository {
  constructor(private readonly db: Db) {}

  async claim(job: string, owner: string, now: Date, intervalMs: number, leaseMs: number): Promise<boolean> {
    const nextRunAt = new Date(now.getTime() + intervalMs);
    const leaseUntil = new Date(now.getTime() + leaseMs);
    // First ever run inserts the row; afterwards the DO UPDATE only applies while the job is
    // due and not leased by someone else — otherwise no row is returned (→ false).
    const row = await this.db
      .insertInto('schedules')
      .values({ job, next_run_at: nextRunAt, last_run_at: now, last_error: null, lease_owner: owner, lease_until: leaseUntil })
      .onConflict((conflict) =>
        conflict
          .column('job')
          .doUpdateSet({ next_run_at: nextRunAt, last_run_at: now, lease_owner: owner, lease_until: leaseUntil })
          .where((eb) =>
            eb.and([
              eb.or([eb('schedules.next_run_at', 'is', null), eb('schedules.next_run_at', '<=', now)]),
              eb.or([eb('schedules.lease_until', 'is', null), eb('schedules.lease_until', '<', now)]),
            ]),
          ),
      )
      .returning('job')
      .executeTakeFirst();
    return row !== undefined;
  }

  async release(job: string, owner: string, outcome: { ok: boolean; error?: string }): Promise<void> {
    await this.db
      .updateTable('schedules')
      .set({ lease_owner: null, lease_until: null, last_error: outcome.ok ? null : (outcome.error ?? 'failed') })
      .where('job', '=', job)
      .where('lease_owner', '=', owner)
      .execute();
  }
}

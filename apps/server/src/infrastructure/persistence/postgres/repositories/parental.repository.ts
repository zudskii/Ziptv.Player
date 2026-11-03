import { randomInt } from 'node:crypto';

import { sql } from 'kysely';

import type { ParentalPinRecord, ParentalRepository } from '../../../../application/ports/parental-repository.js';
import type { LockedChannel, LockedGroup, ParentalRules } from '../../../../domain/viewer/parental.js';
import type { Db } from '../database.js';
import { json } from '../schema.js';

/** Parental PIN (per account) and rules (per profile). */
export class PgParentalRepository implements ParentalRepository {
  constructor(private readonly db: Db) {}

  async findPin(userId: string): Promise<ParentalPinRecord | null> {
    const row = await this.db.selectFrom('parental_pins').selectAll().where('user_id', '=', userId).executeTakeFirst();
    return row ? { userId: row.user_id, pinHash: row.pin_hash, version: row.version, failures: row.failures, lockedUntil: row.locked_until } : null;
  }

  async savePin(userId: string, pinHash: string, now: Date): Promise<void> {
    // A fresh random version (not a counter): a PIN removed and set again must not revive the
    // unlock tokens of the old one, which a restarted counter would.
    const version = randomInt(1, 2 ** 31 - 1);
    await this.db
      .insertInto('parental_pins')
      .values({ user_id: userId, pin_hash: pinHash, version, updated_at: now })
      .onConflict((conflict) => conflict.column('user_id').doUpdateSet({ pin_hash: pinHash, version, failures: 0, locked_until: null, updated_at: now }))
      .execute();
  }

  async deletePin(userId: string): Promise<void> {
    await this.db.deleteFrom('parental_pins').where('user_id', '=', userId).execute();
  }

  async registerFailure(userId: string, maxFailures: number, lockUntil: Date): Promise<{ lockedUntil: Date | null }> {
    // Atomic: parallel wrong guesses each count (no lost update lets a burst exceed the limit).
    const row = await sql<{ locked_until: Date | null; locked: boolean }>`
      UPDATE parental_pins
         SET failures = CASE WHEN failures + 1 >= ${maxFailures} THEN 0 ELSE failures + 1 END,
             locked_until = CASE WHEN failures + 1 >= ${maxFailures} THEN ${lockUntil}::timestamptz ELSE locked_until END
       WHERE user_id = ${userId}
       RETURNING locked_until, (failures = 0) AS locked`.execute(this.db);
    const result = row.rows[0];
    return { lockedUntil: result?.locked ? result.locked_until : null };
  }

  async clearFailures(userId: string): Promise<void> {
    await this.db.updateTable('parental_pins').set({ failures: 0, locked_until: null }).where('user_id', '=', userId).where('failures', '>', 0).execute();
  }

  async rulesOf(userId: string): Promise<Map<string, ParentalRules>> {
    const rows = await this.db
      .selectFrom('parental_rules as r')
      .innerJoin('profiles as p', 'p.id', 'r.profile_id')
      .select(['r.profile_id', 'r.hide_adult', 'r.locked_groups', 'r.locked_channels', 'r.updated_at'])
      .where('p.user_id', '=', userId)
      .execute();
    return new Map(rows.map((row) => [row.profile_id, { hideAdult: row.hide_adult, lockedGroups: row.locked_groups, lockedChannels: row.locked_channels, updatedAt: row.updated_at }]));
  }

  async saveRules(profileId: string, rules: { hideAdult: boolean; lockedGroups: LockedGroup[]; lockedChannels: LockedChannel[] }, now: Date): Promise<void> {
    const values = { hide_adult: rules.hideAdult, locked_groups: json(rules.lockedGroups), locked_channels: json(rules.lockedChannels), updated_at: now };
    await this.db
      .insertInto('parental_rules')
      .values({ profile_id: profileId, ...values })
      .onConflict((conflict) => conflict.column('profile_id').doUpdateSet(values))
      .execute();
  }

  async clearLocks(userId: string, now: Date): Promise<void> {
    await this.db
      .updateTable('parental_rules')
      .set({ locked_groups: json([]), locked_channels: json([]), updated_at: now })
      .where('profile_id', 'in', (eb) => eb.selectFrom('profiles').select('id').where('user_id', '=', userId))
      .execute();
  }
}

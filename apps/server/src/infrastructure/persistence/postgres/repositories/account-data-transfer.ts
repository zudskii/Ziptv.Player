import type { AccountDataTransfer } from '../../../../application/ports/account-data-transfer.js';
import { sql, type Transaction } from 'kysely';

import type { Db } from '../database.js';
import type { Database } from '../schema.js';

export class PgAccountDataTransfer implements AccountDataTransfer {
  constructor(private readonly db: Db) {}

  async mergeGuestInto(guestId: string, accountId: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      // Lock the guest row: only a guest may be absorbed, and never twice concurrently.
      const guest = await trx.selectFrom('users').select('id').where('id', '=', guestId).where('email', 'is', null).forUpdate().executeTakeFirst();
      if (!guest) return false;
      // Every table that has an owner belongs here.
      await trx.updateTable('sources').set({ owner_id: accountId }).where('owner_id', '=', guestId).execute();
      await trx.updateTable('playlists').set({ owner_id: accountId }).where('owner_id', '=', guestId).execute();
      await mergeProfiles(trx, guestId, accountId);
      // The guest's sessions and notifications go with it (ON DELETE CASCADE).
      await trx.deleteFrom('users').where('id', '=', guestId).execute();
      return true;
    });
  }
}

/**
 * Profiles: the guest's default profile merges into the account's default (My List, progress and
 * history carried over; on duplicates the account's rows win), extra guest profiles move as they
 * are. If the account has no profile yet, the guest's default simply becomes its default.
 */
async function mergeProfiles(trx: Transaction<Database>, guestId: string, accountId: string): Promise<void> {
  const guestDefault = await trx.selectFrom('profiles').select('id').where('user_id', '=', guestId).where('is_default', '=', true).executeTakeFirst();
  const accountDefault = await trx.selectFrom('profiles').select('id').where('user_id', '=', accountId).where('is_default', '=', true).executeTakeFirst();
  if (guestDefault && accountDefault) {
    const from = guestDefault.id;
    const to = accountDefault.id;
    await sql`
      INSERT INTO list_items (profile_id, source_id, type, key, title, subtitle, image, added_at)
      SELECT ${to}, source_id, type, key, title, subtitle, image, added_at FROM list_items WHERE profile_id = ${from}
      ON CONFLICT DO NOTHING`.execute(trx);
    await sql`
      INSERT INTO progress (profile_id, source_id, content_type, series_key, key, season, episode, title, series_title, image, position, duration, completed, updated_at)
      SELECT ${to}, source_id, content_type, series_key, key, season, episode, title, series_title, image, position, duration, completed, updated_at FROM progress WHERE profile_id = ${from}
      ON CONFLICT DO NOTHING`.execute(trx);
    await trx.updateTable('history').set({ profile_id: to }).where('profile_id', '=', from).execute();
    // The emptied guest default disappears with the guest (ON DELETE CASCADE).
    await trx.updateTable('profiles').set({ user_id: accountId }).where('user_id', '=', guestId).where('is_default', '=', false).execute();
    return;
  }
  await trx.updateTable('profiles').set({ user_id: accountId }).where('user_id', '=', guestId).execute();
}

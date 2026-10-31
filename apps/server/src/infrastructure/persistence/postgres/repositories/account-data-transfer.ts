import type { AccountDataTransfer } from '../../../../application/ports/account-data-transfer.js';
import type { Db } from '../database.js';

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
      // The guest's sessions and notifications go with it (ON DELETE CASCADE).
      await trx.deleteFrom('users').where('id', '=', guestId).execute();
      return true;
    });
  }
}

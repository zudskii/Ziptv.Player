import type { Selectable } from 'kysely';

import type { NewNotification, NotificationRecord, NotificationRepository } from '../../../../application/ports/notification-repository.js';
import { isEntityId, newEntityId } from '../../../../domain/shared/ids.js';
import type { Db } from '../database.js';
import type { NotificationsTable } from '../schema.js';

function toRecord(row: Selectable<NotificationsTable>): NotificationRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    type: row.type as NotificationRecord['type'],
    severity: row.severity,
    title: row.title,
    body: row.body,
    link: row.link,
    read: row.read,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
  };
}

export class PgNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Db) {}

  async upsert(notification: NewNotification, now: Date): Promise<NotificationRecord> {
    const values = {
      owner_id: notification.ownerId,
      type: notification.type,
      severity: notification.severity,
      title: notification.title,
      body: notification.body,
      link: notification.link,
      dedupe_key: notification.dedupeKey,
      created_at: now,
    };
    const insert = this.db.insertInto('notifications').values({ id: newEntityId(), ...values });
    // The partial unique index (owner, dedupe_key) WHERE unread makes this race-free:
    // an unread notification with the same key is refreshed in place.
    const row = notification.dedupeKey
      ? await insert
          .onConflict((conflict) =>
            conflict
              .columns(['owner_id', 'dedupe_key'])
              .where('read', '=', false)
              .where('dedupe_key', 'is not', null)
              .doUpdateSet({ type: values.type, severity: values.severity, title: values.title, body: values.body, link: values.link, created_at: now }),
          )
          .returningAll()
          .executeTakeFirstOrThrow()
      : await insert.returningAll().executeTakeFirstOrThrow();
    return toRecord(row);
  }

  async list(ownerId: string, limit: number): Promise<NotificationRecord[]> {
    const rows = await this.db.selectFrom('notifications').selectAll().where('owner_id', '=', ownerId).orderBy('created_at', 'desc').limit(limit).execute();
    return rows.map(toRecord);
  }

  async unreadCount(ownerId: string): Promise<number> {
    const row = await this.db
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('owner_id', '=', ownerId)
      .where('read', '=', false)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async markRead(ownerId: string, ids: string[] | 'all'): Promise<void> {
    let query = this.db.updateTable('notifications').set({ read: true }).where('owner_id', '=', ownerId).where('read', '=', false);
    if (ids !== 'all') {
      const valid = ids.filter(isEntityId);
      if (valid.length === 0) return;
      query = query.where('id', 'in', valid);
    }
    await query.execute();
  }

  async deleteOwned(ownerId: string, id: string): Promise<boolean> {
    if (!isEntityId(id)) return false;
    const result = await this.db.deleteFrom('notifications').where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const result = await this.db.deleteFrom('notifications').where('created_at', '<', cutoff).executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async deleteForOwner(ownerId: string): Promise<void> {
    await this.db.deleteFrom('notifications').where('owner_id', '=', ownerId).execute();
  }
}

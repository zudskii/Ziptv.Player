import type { Selectable } from 'kysely';

import type { ProfileRecord, ProfileRepository } from '../../../../application/ports/profile-repository.js';
import { isEntityId, newEntityId } from '../../../../domain/shared/ids.js';
import type { ProfileKind } from '../../../../domain/viewer/profile.js';
import type { StoredProfileSettings } from '../../../../domain/viewer/settings.js';
import type { Db } from '../database.js';
import { json, type ProfilesTable } from '../schema.js';

function toRecord(row: Selectable<ProfilesTable>): ProfileRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    color: row.color,
    kind: row.kind,
    isDefault: row.is_default,
    settings: row.settings,
    createdAt: row.created_at,
  };
}

export class PgProfileRepository implements ProfileRepository {
  constructor(private readonly db: Db) {}

  newId(): string {
    return newEntityId();
  }

  isValidId(id: string): boolean {
    return isEntityId(id);
  }

  async listByUser(userId: string): Promise<ProfileRecord[]> {
    const rows = await this.db.selectFrom('profiles').selectAll().where('user_id', '=', userId).orderBy('is_default', 'desc').orderBy('created_at').orderBy('id').execute();
    return rows.map(toRecord);
  }

  async ensureDefault(userId: string, input: { id: string; name: string; color: string }): Promise<void> {
    // The partial unique index (user_id) WHERE is_default makes concurrent first requests safe.
    await this.db
      .insertInto('profiles')
      .values({ id: input.id, user_id: userId, name: input.name, color: input.color, kind: 'standard', is_default: true })
      .onConflict((conflict) => conflict.column('user_id').where('is_default', '=', true).doNothing())
      .execute();
  }

  async create(input: { id: string; userId: string; name: string; color: string; kind: ProfileKind }, max: number): Promise<ProfileRecord | null> {
    return this.db.transaction().execute(async (trx) => {
      // Serialise creations of one account so two parallel requests cannot exceed the limit.
      await trx.selectFrom('users').select('id').where('id', '=', input.userId).forUpdate().executeTakeFirst();
      const { count } = await trx.selectFrom('profiles').select((eb) => eb.fn.countAll<string>().as('count')).where('user_id', '=', input.userId).executeTakeFirstOrThrow();
      if (Number(count) >= max) return null;
      const row = await trx
        .insertInto('profiles')
        .values({ id: input.id, user_id: input.userId, name: input.name, color: input.color, kind: input.kind, is_default: false })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRecord(row);
    });
  }

  async update(id: string, userId: string, patch: { name?: string; color?: string; kind?: ProfileKind }): Promise<ProfileRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db
      .updateTable('profiles')
      .set({
        updated_at: new Date(),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async saveSettings(id: string, userId: string, settings: StoredProfileSettings): Promise<ProfileRecord | null> {
    if (!isEntityId(id)) return null;
    const row = await this.db
      .updateTable('profiles')
      .set({ settings: json(settings), updated_at: new Date() })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async delete(id: string, userId: string): Promise<boolean> {
    if (!isEntityId(id)) return false;
    const result = await this.db.deleteFrom('profiles').where('id', '=', id).where('user_id', '=', userId).where('is_default', '=', false).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}

import type { Selectable } from 'kysely';

import type { UserRecord, UserRepository, UserWithPassword } from '../../../../application/ports/user-repository.js';
import { newEntityId } from '../../../../domain/shared/ids.js';
import type { Db } from '../database.js';
import { isUniqueViolation } from '../errors.js';
import type { UsersTable } from '../schema.js';

type UserRow = Selectable<UsersTable>;

function toRecord(row: UserRow): UserRecord {
  return { id: row.id, email: row.email, role: row.role, emailVerifiedAt: row.email_verified_at, createdAt: row.created_at, lastSeenAt: row.last_seen_at };
}

export class PgUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  async createGuest(): Promise<UserRecord> {
    const row = await this.db.insertInto('users').values({ id: newEntityId(), email: null, password_hash: null, email_verified_at: null, legacy_secret_id: null }).returningAll().executeTakeFirstOrThrow();
    return toRecord(row);
  }

  async createAccount(input: { email: string; passwordHash: string }): Promise<UserRecord | null> {
    try {
      const row = await this.db
        .insertInto('users')
        .values({ id: newEntityId(), email: input.email, password_hash: input.passwordHash, email_verified_at: null, legacy_secret_id: null })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async promoteGuest(userId: string, input: { email: string; passwordHash: string }): Promise<UserRecord | null> {
    try {
      const row = await this.db
        .updateTable('users')
        .set({ email: input.email, password_hash: input.passwordHash })
        .where('id', '=', userId)
        .where('email', 'is', null)
        .returningAll()
        .executeTakeFirst();
      return row ? toRecord(row) : null;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async findByEmail(email: string): Promise<UserWithPassword | null> {
    const row = await this.db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
    return row ? { ...toRecord(row), passwordHash: row.password_hash } : null;
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.updateTable('users').set({ password_hash: passwordHash }).where('id', '=', userId).where('email', 'is not', null).execute();
  }

  async markEmailVerified(userId: string, at: Date): Promise<void> {
    await this.db.updateTable('users').set({ email_verified_at: at }).where('id', '=', userId).where('email', 'is not', null).where('email_verified_at', 'is', null).execute();
  }

  async claimLegacy(legacySecretId: string): Promise<UserRecord | null> {
    const row = await this.db
      .updateTable('users')
      .set({ legacy_secret_id: null, last_seen_at: new Date() })
      .where('legacy_secret_id', '=', legacySecretId)
      .returningAll()
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async delete(userId: string): Promise<boolean> {
    const result = await this.db.deleteFrom('users').where('id', '=', userId).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}

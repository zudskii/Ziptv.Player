import type { Selectable } from 'kysely';

import type { NewSession, SessionRecord, SessionRepository } from '../../../../application/ports/session-repository.js';
import type { UserRecord } from '../../../../application/ports/user-repository.js';
import type { Db } from '../database.js';
import type { SessionsTable } from '../schema.js';

function toRecord(row: Selectable<SessionsTable>): SessionRecord {
  return { id: row.id, userId: row.user_id, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, userAgent: row.user_agent };
}

export class PgSessionRepository implements SessionRepository {
  constructor(private readonly db: Db) {}

  async create(session: NewSession): Promise<SessionRecord> {
    const row = await this.db
      .insertInto('sessions')
      .values({
        id: session.id,
        user_id: session.userId,
        token_hash: session.tokenHash,
        expires_at: session.expiresAt,
        user_agent: session.userAgent,
        created_at: session.createdAt,
        last_seen_at: session.createdAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }

  async findByTokenHash(tokenHash: string): Promise<{ session: SessionRecord; user: UserRecord } | null> {
    const row = await this.db
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select([
        'sessions.id as session_id',
        'sessions.user_id as session_user_id',
        'sessions.created_at as session_created_at',
        'sessions.last_seen_at as session_last_seen_at',
        'sessions.expires_at as session_expires_at',
        'sessions.user_agent as session_user_agent',
        'users.id as user_id',
        'users.email as user_email',
        'users.role as user_role',
        'users.email_verified_at as user_email_verified_at',
        'users.created_at as user_created_at',
        'users.last_seen_at as user_last_seen_at',
      ])
      .where('sessions.token_hash', '=', tokenHash)
      .executeTakeFirst();
    if (!row) return null;
    return {
      session: {
        id: row.session_id,
        userId: row.session_user_id,
        createdAt: row.session_created_at,
        lastSeenAt: row.session_last_seen_at,
        expiresAt: row.session_expires_at,
        userAgent: row.session_user_agent,
      },
      user: { id: row.user_id, email: row.user_email, role: row.user_role, emailVerifiedAt: row.user_email_verified_at, createdAt: row.user_created_at, lastSeenAt: row.user_last_seen_at },
    };
  }

  async touch(sessionId: string, userId: string, at: Date, expiresAt?: Date): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ last_seen_at: at, ...(expiresAt ? { expires_at: expiresAt } : {}) })
      .where('id', '=', sessionId)
      .execute();
    await this.db.updateTable('users').set({ last_seen_at: at }).where('id', '=', userId).execute();
  }

  async listForUser(userId: string): Promise<SessionRecord[]> {
    const rows = await this.db.selectFrom('sessions').selectAll().where('user_id', '=', userId).orderBy('last_seen_at', 'desc').execute();
    return rows.map(toRecord);
  }

  async isActive(sessionId: string, now: Date): Promise<boolean> {
    const row = await this.db
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', sessionId)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
      .executeTakeFirst();
    return row !== undefined;
  }

  async delete(sessionId: string): Promise<void> {
    await this.db.deleteFrom('sessions').where('id', '=', sessionId).execute();
  }

  async deleteOwned(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.db.deleteFrom('sessions').where('id', '=', sessionId).where('user_id', '=', userId).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async deleteForUser(userId: string, keepSessionId?: string): Promise<void> {
    let query = this.db.deleteFrom('sessions').where('user_id', '=', userId);
    if (keepSessionId) query = query.where('id', '<>', keepSessionId);
    await query.execute();
  }

  async purgeExpired(now: Date): Promise<number> {
    const result = await this.db.deleteFrom('sessions').where('expires_at', '<', now).executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

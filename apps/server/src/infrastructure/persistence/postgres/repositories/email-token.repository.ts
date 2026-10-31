import type { EmailTokenPurpose, EmailTokenRecord, EmailTokenRepository, NewEmailToken } from '../../../../application/ports/email-token-repository.js';
import type { Db } from '../database.js';

export class PgEmailTokenRepository implements EmailTokenRepository {
  constructor(private readonly db: Db) {}

  async create(token: NewEmailToken): Promise<void> {
    await this.db
      .insertInto('email_tokens')
      .values({ id: token.id, user_id: token.userId, purpose: token.purpose, token_hash: token.tokenHash, email: token.email, expires_at: token.expiresAt, used_at: null, created_at: token.createdAt })
      .execute();
  }

  async findByHash(tokenHash: string): Promise<EmailTokenRecord | null> {
    const row = await this.db.selectFrom('email_tokens').selectAll().where('token_hash', '=', tokenHash).executeTakeFirst();
    return row ? { id: row.id, userId: row.user_id, purpose: row.purpose, email: row.email, expiresAt: row.expires_at, usedAt: row.used_at } : null;
  }

  async consume(id: string, now: Date): Promise<boolean> {
    // One conditional UPDATE is the whole lock: the row can be flipped from unused to used only once.
    const result = await this.db.updateTable('email_tokens').set({ used_at: now }).where('id', '=', id).where('used_at', 'is', null).where('expires_at', '>', now).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async invalidateForUser(userId: string, purpose: EmailTokenPurpose): Promise<void> {
    await this.db.deleteFrom('email_tokens').where('user_id', '=', userId).where('purpose', '=', purpose).where('used_at', 'is', null).execute();
  }

  async purgeExpired(now: Date): Promise<number> {
    // Used tokens are kept until they expire too, so a replayed link still reads "used", not "unknown".
    const result = await this.db.deleteFrom('email_tokens').where('expires_at', '<', now).executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

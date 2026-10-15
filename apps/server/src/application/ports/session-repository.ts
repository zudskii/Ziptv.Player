import type { UserRecord } from './user-repository.js';

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  /** null = never expires (guest sessions). */
  expiresAt: Date | null;
  userAgent: string | null;
}

export interface NewSession {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date | null;
  userAgent: string | null;
  /** Creation time from the application clock (the same clock that computes expiry). */
  createdAt: Date;
}

/** Persistence port for bearer sessions (one row per signed-in device). */
export interface SessionRepository {
  create(session: NewSession): Promise<SessionRecord>;
  /** Session + its user, for authenticating a request. Expired sessions are not filtered here. */
  findByTokenHash(tokenHash: string): Promise<{ session: SessionRecord; user: UserRecord } | null>;
  /** Marks activity; `expiresAt` slides the expiry of account sessions (undefined = leave as is). */
  touch(sessionId: string, userId: string, at: Date, expiresAt?: Date): Promise<void>;
  listForUser(userId: string): Promise<SessionRecord[]>;
  delete(sessionId: string): Promise<void>;
  deleteOwned(userId: string, sessionId: string): Promise<boolean>;
  /** Signs out every device of the user, except `keepSessionId` when given. */
  deleteForUser(userId: string, keepSessionId?: string): Promise<void>;
  purgeExpired(now: Date): Promise<number>;
}

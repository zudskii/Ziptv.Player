import { createHash, randomBytes } from 'node:crypto';

import type { MeDto, SessionDto } from '@ziptv/contracts';

import type { UserRole } from '../../domain/identity/credentials.js';
import { isGuest } from '../../domain/identity/credentials.js';
import { newEntityId } from '../../domain/shared/ids.js';
import type { Logger } from '../ports/logger.js';
import type { SessionRecord, SessionRepository } from '../ports/session-repository.js';
import type { UserRepository } from '../ports/user-repository.js';

/** Who a request belongs to, as established from its bearer token. */
export interface AuthUser {
  id: string;
  createdAt: Date;
  /** null = guest. */
  email: string | null;
  role: UserRole;
  /** The session (device) this request came in with. */
  sessionId: string;
}

export interface IssuedSession {
  token: string;
  sessionId: string;
  expiresAt: Date | null;
}

/** 32 random bytes, base64url. Anything else is rejected before touching the database. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const MAX_USER_AGENT = 200;

/**
 * Bearer sessions: issuing, authenticating, listing and revoking them.
 *
 * Tokens are 256-bit CSPRNG values, travel only in the Authorization header and are stored as
 * SHA-256 hashes, so a database leak does not leak usable credentials. Guest sessions (the
 * anonymous device identity) never expire; account sessions expire after `accountSessionTtlMs`
 * of inactivity (the expiry slides forward while the device is in use).
 */
export class SessionService {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly logger: Logger,
    private readonly options: { accountSessionTtlMs: number },
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The anonymous identity of a device. A 1.x client may exchange its old secret id once. */
  async createGuestSession(input: { legacySecretId?: string | undefined; userAgent?: string | null | undefined }): Promise<SessionDto> {
    if (input.legacySecretId) {
      const migrated = await this.users.claimLegacy(input.legacySecretId);
      if (migrated) {
        this.logger.info({ userId: migrated.id }, 'Legacy session migrated');
        const issued = await this.issue(migrated, input.userAgent);
        return { token: issued.token, userId: migrated.id, migratedFromLegacy: true };
      }
    }
    const user = await this.users.createGuest();
    const issued = await this.issue(user, input.userAgent);
    return { token: issued.token, userId: user.id, migratedFromLegacy: false };
  }

  /** New session (device) for a user. */
  async issue(user: { id: string; email: string | null }, userAgent?: string | null): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const expiresAt = isGuest(user) ? null : new Date(now.getTime() + this.options.accountSessionTtlMs);
    const session = await this.sessions.create({
      id: newEntityId(),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: userAgent ? userAgent.slice(0, MAX_USER_AGENT) : null,
      createdAt: now,
    });
    return { token, sessionId: session.id, expiresAt: session.expiresAt };
  }

  async authenticate(token: string): Promise<AuthUser | null> {
    if (!TOKEN_FORMAT.test(token)) return null;
    const found = await this.sessions.findByTokenHash(hashToken(token));
    if (!found) return null;

    const { session, user } = found;
    const now = this.now();
    if (session.expiresAt && session.expiresAt.getTime() <= now.getTime()) return null;

    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const slid = session.expiresAt ? new Date(now.getTime() + this.options.accountSessionTtlMs) : undefined;
      // Fire-and-forget: activity tracking must never fail a request.
      this.sessions.touch(session.id, user.id, now, slid).catch((error: unknown) => this.logger.warn({ err: error }, 'Failed to update session activity'));
    }
    return { id: user.id, createdAt: user.createdAt, email: user.email, role: user.role, sessionId: session.id };
  }

  list(userId: string): Promise<SessionRecord[]> {
    return this.sessions.listForUser(userId);
  }

  revoke(sessionId: string): Promise<void> {
    return this.sessions.delete(sessionId);
  }

  revokeOwned(userId: string, sessionId: string): Promise<boolean> {
    return this.sessions.deleteOwned(userId, sessionId);
  }

  /** Signs the user out everywhere, optionally keeping the device that asked. */
  revokeAll(userId: string, keepSessionId?: string): Promise<void> {
    return this.sessions.deleteForUser(userId, keepSessionId);
  }

  purgeExpired(): Promise<number> {
    return this.sessions.purgeExpired(this.now());
  }

  toMe(user: Pick<AuthUser, 'id' | 'createdAt' | 'email' | 'role'>): MeDto {
    return { userId: user.id, createdAt: user.createdAt.toISOString(), email: user.email, isGuest: isGuest(user), role: user.role };
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

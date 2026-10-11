import { createHash, randomBytes } from 'node:crypto';

import type { MeDto, SessionDto } from '@ziptv/contracts';

import type { Logger } from '../ports/logger.js';
import type { UserRepository } from '../ports/user-repository.js';

export interface AuthUser {
  id: string;
  createdAt: Date;
}

/** 32 random bytes, base64url. Anything else is rejected before touching the database. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Anonymous device identity (the app has no accounts).
 *
 * Replaces the old `secretId` (Math.random, sent in URLs): tokens are 256-bit CSPRNG values,
 * travel only in the Authorization header, and are stored as SHA-256 hashes, so a database
 * leak does not leak usable credentials.
 */
export class SessionService {
  constructor(
    private readonly users: UserRepository,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createSession(input: { legacySecretId?: string | undefined }): Promise<SessionDto> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);

    if (input.legacySecretId) {
      const migrated = await this.users.claimLegacy(input.legacySecretId, tokenHash);
      if (migrated) {
        this.logger.info({ userId: migrated.id }, 'Legacy session migrated');
        return { token, userId: migrated.id, migratedFromLegacy: true };
      }
    }

    const user = await this.users.create(tokenHash);
    return { token, userId: user.id, migratedFromLegacy: false };
  }

  async authenticate(token: string): Promise<AuthUser | null> {
    if (!TOKEN_FORMAT.test(token)) return null;
    const user = await this.users.findByTokenHash(hashToken(token));
    if (!user) return null;

    const now = this.now();
    if (now.getTime() - user.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      // Fire-and-forget: activity tracking must never fail a request.
      this.users.touch(user.id, now).catch((error: unknown) => this.logger.warn({ err: error }, 'Failed to update lastSeenAt'));
    }
    return { id: user.id, createdAt: user.createdAt };
  }

  toMe(user: AuthUser): MeDto {
    return { userId: user.id, createdAt: user.createdAt.toISOString() };
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

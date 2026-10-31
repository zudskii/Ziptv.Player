import type { AuthSessionDto, SessionInfoDto } from '@ziptv/contracts';

import { isGuest, normalizeEmail, passwordProblem } from '../../domain/identity/credentials.js';
import { AppError } from '../errors.js';
import type { AccountDataTransfer } from '../ports/account-data-transfer.js';
import type { Logger } from '../ports/logger.js';
import type { PasswordHasher } from '../ports/password-hasher.js';
import type { PlaylistRepository } from '../ports/playlist-repository.js';
import type { SourceRepository } from '../ports/source-repository.js';
import type { UserRecord, UserRepository } from '../ports/user-repository.js';
import type { AuthUser, SessionService } from './session.service.js';

export interface RequestContext {
  /** The authenticated caller, if the request carried a valid token (a guest, for register/login). */
  current: AuthUser | null;
  userAgent: string | null;
}

/**
 * Use cases of an account: register (or upgrade a guest), log in and out, devices, password,
 * delete. Sessions themselves are SessionService's job; this class decides who may get one.
 */
export class AccountService {
  constructor(
    private readonly deps: {
      users: UserRepository;
      sessions: SessionService;
      hasher: PasswordHasher;
      transfer: AccountDataTransfer;
      sources: SourceRepository;
      playlists: Pick<PlaylistRepository, 'countByOwner'>;
      limits: { maxSourcesPerUser: number; maxPlaylistsPerUser: number };
      logger: Logger;
      /** Runs after an account was created (the confirmation email goes out from here); must not throw. */
      afterRegister?: (user: { id: string; email: string }) => void;
    },
  ) {}

  /**
   * Creates an account. When the caller is a guest the guest *becomes* the account (same id,
   * so every source it added stays); otherwise a fresh user is created. Either way the caller
   * gets a new token and, for a guest, the old one stops working (privilege change → rotate).
   */
  async register(input: { email: string; password: string }, context: RequestContext): Promise<AuthSessionDto> {
    const email = normalizeEmail(input.email);
    const problem = passwordProblem(input.password, email);
    if (problem) throw AppError.validation(problem, [{ path: 'password', message: problem }]);

    const passwordHash = await this.deps.hasher.hash(input.password);
    const guest = context.current && isGuest(context.current) ? context.current : null;
    const user = guest
      ? await this.deps.users.promoteGuest(guest.id, { email, passwordHash })
      : await this.deps.users.createAccount({ email, passwordHash });
    if (!user) throw new AppError('EMAIL_TAKEN', 409, 'An account with this email already exists.');

    if (guest) await this.deps.sessions.revokeAll(user.id); // the guest token(s)
    this.deps.logger.info({ userId: user.id, upgradedGuest: guest !== null }, 'Account registered');
    this.deps.afterRegister?.({ id: user.id, email });
    return this.start(user, context.userAgent);
  }

  async login(input: { email: string; password: string; mergeGuest?: boolean | undefined }, context: RequestContext): Promise<AuthSessionDto> {
    const email = normalizeEmail(input.email);
    const found = await this.deps.users.findByEmail(email);
    // Same work and same answer whether the email is unknown or the password is wrong.
    const ok = await this.deps.hasher.verify(input.password, found?.passwordHash ?? null);
    if (!found || !found.passwordHash || !ok) throw new AppError('INVALID_CREDENTIALS', 401, 'Invalid email or password.');

    if (this.deps.hasher.needsRehash(found.passwordHash)) {
      await this.deps.users.setPassword(found.id, await this.deps.hasher.hash(input.password));
    }

    const guest = context.current && isGuest(context.current) ? context.current : null;
    if (guest && input.mergeGuest && guest.id !== found.id) await this.mergeGuest(guest.id, found.id);

    return this.start(found, context.userAgent);
  }

  async logout(user: AuthUser): Promise<void> {
    await this.deps.sessions.revoke(user.sessionId);
  }

  async listSessions(user: AuthUser): Promise<SessionInfoDto[]> {
    const sessions = await this.deps.sessions.list(user.id);
    return sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
      userAgent: session.userAgent,
      current: session.id === user.sessionId,
    }));
  }

  async revokeSession(user: AuthUser, sessionId: string): Promise<void> {
    if (!(await this.deps.sessions.revokeOwned(user.id, sessionId))) throw AppError.notFound('Session');
  }

  /** Changing the password signs every other device out (a stolen session must not survive it). */
  async changePassword(user: AuthUser, input: { currentPassword: string; newPassword: string }): Promise<void> {
    const account = await this.requireAccount(user);
    await this.assertPassword(account, input.currentPassword, 'Current password is incorrect.');
    const problem = passwordProblem(input.newPassword, account.email);
    if (problem) throw AppError.validation(problem, [{ path: 'newPassword', message: problem }]);

    await this.deps.users.setPassword(user.id, await this.deps.hasher.hash(input.newPassword));
    await this.deps.sessions.revokeAll(user.id, user.sessionId);
    this.deps.logger.info({ userId: user.id }, 'Password changed');
  }

  /** Deletes the account and everything it owns (sources, catalogs, notifications, sessions). */
  async deleteAccount(user: AuthUser, input: { password: string }): Promise<void> {
    const account = await this.requireAccount(user);
    await this.assertPassword(account, input.password, 'Password is incorrect.');
    await this.deps.users.delete(user.id);
    this.deps.logger.info({ userId: user.id }, 'Account deleted');
  }

  // ---------------------------------------------------------------------------------------

  private async start(user: UserRecord, userAgent: string | null): Promise<AuthSessionDto> {
    const issued = await this.deps.sessions.issue(user, userAgent);
    return { token: issued.token, expiresAt: issued.expiresAt ? issued.expiresAt.toISOString() : null, user: this.deps.sessions.toMe({ ...user, emailVerified: user.emailVerifiedAt !== null }) };
  }

  private async mergeGuest(guestId: string, accountId: string): Promise<void> {
    const { sources, playlists, limits } = this.deps;
    const [guestPlaylists, accountPlaylists] = await Promise.all([playlists.countByOwner(guestId), playlists.countByOwner(accountId)]);
    if (guestPlaylists + accountPlaylists > limits.maxPlaylistsPerUser) {
      throw new AppError(
        'PLAYLIST_LIMIT_REACHED',
        409,
        `Merging would exceed the limit of ${limits.maxPlaylistsPerUser} playlists (${accountPlaylists} in your account + ${guestPlaylists} on this device). Remove some first, or log in without merging.`,
      );
    }
    const [guestCount, accountCount] = await Promise.all([sources.countByOwner(guestId), sources.countByOwner(accountId)]);
    if (guestCount + accountCount > limits.maxSourcesPerUser) {
      throw new AppError(
        'SOURCE_LIMIT_REACHED',
        409,
        `Merging would exceed the limit of ${limits.maxSourcesPerUser} sources (${accountCount} in your account + ${guestCount} on this device). Remove some first, or log in without merging.`,
      );
    }
    if (await this.deps.transfer.mergeGuestInto(guestId, accountId)) {
      this.deps.logger.info({ guestId, accountId, sources: guestCount }, 'Guest data merged into account');
    }
  }

  private async requireAccount(user: AuthUser): Promise<UserRecord & { email: string }> {
    const account = await this.deps.users.findById(user.id);
    if (!account || account.email === null) throw AppError.forbidden('Create an account first: this device is using a guest identity.');
    return { ...account, email: account.email };
  }

  /**
   * Re-authentication on an already signed-in request. Answers 403, not 401: a 401 makes the
   * web client think its session died and silently start a new guest session.
   */
  private async assertPassword(account: { id: string; email: string }, password: string, message: string): Promise<void> {
    const found = await this.deps.users.findByEmail(account.email);
    if (!(await this.deps.hasher.verify(password, found?.passwordHash ?? null))) throw new AppError('INVALID_CREDENTIALS', 403, message);
  }
}

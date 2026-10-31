import { createHash, randomBytes } from 'node:crypto';

import type { AuthFeaturesDto } from '@ziptv/contracts';

import { normalizeEmail, passwordProblem } from '../../domain/identity/credentials.js';
import { newEntityId } from '../../domain/shared/ids.js';
import { AppError } from '../errors.js';
import type { EmailTokenPurpose, EmailTokenRepository } from '../ports/email-token-repository.js';
import type { Logger } from '../ports/logger.js';
import type { Mailer } from '../ports/mailer.js';
import type { PasswordHasher } from '../ports/password-hasher.js';
import type { UserRepository } from '../ports/user-repository.js';
import { passwordResetMail, verifyEmailMail } from './mail-templates.js';
import type { AuthUser, SessionService } from './session.service.js';

const RESET_TTL_MINUTES = 60;
const VERIFY_TTL_HOURS = 24;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const invalidToken = () => new AppError('INVALID_TOKEN', 400, 'This link is invalid or has expired. Request a new one.');

/**
 * Password reset and address confirmation, both by a link in an email.
 *
 * Rules that matter:
 *  - The link is built from the configured public address, never from the request (a forged Host
 *    header must not be able to point a victim's email at another site).
 *  - Tokens are 256 random bits, stored hashed, single-use, expiring, and the token carries its
 *    secret in the URL *fragment* (never sent to servers, absent from logs and Referer headers).
 *  - "Forgot password" answers the same whether or not the address exists, and sends the email
 *    after answering, so neither the response nor its timing says which addresses are registered.
 */
export class EmailFlowService {
  constructor(
    private readonly deps: {
      users: UserRepository;
      tokens: EmailTokenRepository;
      sessions: SessionService;
      hasher: PasswordHasher;
      /** null = the server cannot send mail. */
      mailer: Mailer | null;
      /** Origin for links in emails; null = cannot build them. */
      publicUrl: string | null;
      clock: () => Date;
      logger: Logger;
    },
  ) {}

  get enabled(): boolean {
    return this.deps.mailer !== null && this.deps.publicUrl !== null;
  }

  features(): AuthFeaturesDto {
    return { passwordReset: this.enabled, emailVerification: this.enabled };
  }

  // --- forgotten password -------------------------------------------------------------------

  async requestPasswordReset(email: string): Promise<void> {
    this.requireEnabled();
    const found = await this.deps.users.findByEmail(normalizeEmail(email));
    if (!found?.email) return; // same answer for an address nobody registered
    const user = { id: found.id, email: found.email };
    this.dispatch(this.sendLink(user, 'reset_password'), 'password reset');
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    this.requireEnabled();
    const record = await this.find(token, 'reset_password');
    const user = await this.deps.users.findById(record.userId);
    if (!user?.email || user.email !== record.email) throw invalidToken();

    // The policy is checked before the token is spent, so a too-weak password can be corrected on the same link.
    const problem = passwordProblem(newPassword, user.email);
    if (problem) throw AppError.validation(problem, [{ path: 'password', message: problem }]);

    const now = this.deps.clock();
    if (!(await this.deps.tokens.consume(record.id, now))) throw invalidToken(); // used a moment ago by someone else

    await this.deps.users.setPassword(user.id, await this.deps.hasher.hash(newPassword));
    // Whoever opened the link controls the mailbox: that also confirms the address.
    await this.deps.users.markEmailVerified(user.id, now);
    // A password reset means "I may have lost control": every device is signed out, other links die.
    await this.deps.sessions.revokeAll(user.id);
    await this.deps.tokens.invalidateForUser(user.id, 'reset_password');
    this.deps.logger.info({ userId: user.id }, 'Password reset by email link');
  }

  // --- address confirmation -----------------------------------------------------------------

  /** Asked for by a signed-in account (resend). */
  async sendVerification(user: AuthUser): Promise<void> {
    this.requireEnabled();
    if (!user.email) throw AppError.forbidden('Create an account first: a guest has no email address to confirm.');
    if (user.emailVerified) return;
    await this.sendLink({ id: user.id, email: user.email }, 'verify_email');
  }

  /** Right after registration: best effort, never in the way of registering. */
  sendVerificationTo(user: { id: string; email: string }): void {
    if (!this.enabled) return;
    this.dispatch(this.sendLink(user, 'verify_email'), 'address confirmation');
  }

  async verifyEmail(token: string): Promise<void> {
    this.requireEnabled();
    const record = await this.find(token, 'verify_email');
    const user = await this.deps.users.findById(record.userId);
    if (!user?.email || user.email !== record.email) throw invalidToken();
    const now = this.deps.clock();
    if (!(await this.deps.tokens.consume(record.id, now))) throw invalidToken();
    await this.deps.users.markEmailVerified(user.id, now);
  }

  purgeExpired(): Promise<number> {
    return this.deps.tokens.purgeExpired(this.deps.clock());
  }

  // ---------------------------------------------------------------------------------------

  private requireEnabled(): void {
    if (!this.enabled) throw new AppError('FEATURE_DISABLED', 501, 'This server is not set up to send email.');
  }

  /** Looks a token up; anything wrong with it (malformed, unknown, wrong kind, used, expired) is the same "invalid" answer. */
  private async find(token: string, purpose: EmailTokenPurpose) {
    if (!TOKEN_FORMAT.test(token)) throw invalidToken();
    const record = await this.deps.tokens.findByHash(hashToken(token));
    if (!record || record.purpose !== purpose || record.usedAt !== null || record.expiresAt.getTime() <= this.deps.clock().getTime()) throw invalidToken();
    return record;
  }

  /** New link for the user (replacing their unused ones) and the email that carries it. */
  private async sendLink(user: { id: string; email: string }, purpose: EmailTokenPurpose): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const now = this.deps.clock();
    const ttlMs = purpose === 'reset_password' ? RESET_TTL_MINUTES * 60_000 : VERIFY_TTL_HOURS * 3_600_000;
    await this.deps.tokens.invalidateForUser(user.id, purpose);
    await this.deps.tokens.create({ id: newEntityId(), userId: user.id, purpose, tokenHash: hashToken(token), email: user.email, expiresAt: new Date(now.getTime() + ttlMs), createdAt: now });

    // The fragment keeps the secret out of server logs and Referer headers; the page reads it in the browser.
    const base = this.deps.publicUrl!;
    const mail = purpose === 'reset_password' ? passwordResetMail(`${base}/reset-password#token=${token}`, RESET_TTL_MINUTES) : verifyEmailMail(`${base}/verify-email#token=${token}`, VERIFY_TTL_HOURS);
    await this.deps.mailer!.send({ to: user.email, ...mail });
  }

  /** Runs after the response has been decided; a mail server problem is logged, never shown. */
  private dispatch(task: Promise<void>, what: string): void {
    task.catch((error: unknown) => this.deps.logger.error({ err: error }, `Could not send the ${what} email`));
  }
}

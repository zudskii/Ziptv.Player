import { createHash, randomBytes } from 'node:crypto';

import type { AdminLoginResponse, AdminSessionDto } from '@ziptv/contracts';

import { newTotpSecret, totpUri, verifyTotp } from '../../domain/admin/totp.js';
import { normalizeEmail, passwordProblem } from '../../domain/identity/credentials.js';
import { newEntityId } from '../../domain/shared/ids.js';
import { AppError } from '../errors.js';
import type { AdminUnitOfWork, StaffRepository, StaffSessionRepository, StaffWithPassword } from '../ports/admin.js';
import type { SecretCipher } from '../ports/cipher.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import { OUTBOX_JOB } from '../outbox/outbox-dispatcher.js';
import type { PasswordHasher } from '../ports/password-hasher.js';
import type { JobKicker } from '../sources/hooks.js';
import { actorOf, toMeDto, toPrincipal, type AdminContext, type StaffPrincipal } from './principal.js';

const CHALLENGE_TTL_MS = 5 * 60_000;
/** Consecutive wrong codes before the account is locked, and for how long (counted per account, not per IP). */
export const MFA_FAILURE_LIMIT = 5;
export const MFA_LOCK_MS = 15 * 60_000;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60_000;

interface Challenge {
  /** staff id */
  s: string;
  /** expiry (ms) */
  e: number;
  m: 'verify' | 'enroll';
  /** enrollment: the secret being set up (only stored once a valid code proves it was scanned) */
  k?: string;
  /** credentials fingerprint: a password or 2FA reset invalidates challenges issued before it */
  f: string;
}

export interface StaffAuthConfig {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  issuer: string;
}

const invalidCredentials = () => new AppError('INVALID_CREDENTIALS', 401, 'Email or password is incorrect.');

/**
 * Console sign-in: password, then a TOTP code — always. A password alone never yields a
 * session, and the first sign-in enrols the authenticator. Sessions are short (idle + absolute
 * expiry) and stored hashed. Successful and failed attempts on real staff accounts are audited.
 */
export class StaffAuthService {
  constructor(
    private readonly deps: {
      staff: StaffRepository;
      sessions: StaffSessionRepository;
      uow: AdminUnitOfWork;
      hasher: PasswordHasher;
      cipher: SecretCipher;
      clock: Clock;
      logger: Logger;
      config: StaffAuthConfig;
      jobs?: JobKicker;
    },
  ) {}

  async login(input: { email: string; password: string }, context: AdminContext): Promise<AdminLoginResponse> {
    const staff = await this.deps.staff.findByEmail(normalizeEmail(input.email));
    // Always runs the hasher (unknown email included): timing does not reveal staff emails.
    const valid = await this.deps.hasher.verify(input.password, staff?.passwordHash ?? null);
    if (!staff || !valid || staff.disabledAt) {
      // Not awaited: the extra write must not make known staff emails answer measurably slower.
      if (staff) void this.auditFailure(staff, valid ? 'disabled' : 'password', context);
      throw invalidCredentials();
    }
    this.assertNotLocked(staff);
    const f = fingerprint(staff);
    if (staff.mfaEnabledAt && staff.mfaSecret) return { step: 'mfa', challenge: this.seal({ s: staff.id, e: this.now() + CHALLENGE_TTL_MS, m: 'verify', f }) };
    const secret = newTotpSecret();
    return {
      step: 'enroll',
      challenge: this.seal({ s: staff.id, e: this.now() + CHALLENGE_TTL_MS, m: 'enroll', k: secret, f }),
      secret,
      otpauthUri: totpUri(secret, staff.email, this.deps.config.issuer),
    };
  }

  async verifyMfa(input: { challenge: string; code: string }, context: AdminContext): Promise<AdminSessionDto> {
    const challenge = this.open(input.challenge);
    const staff = await this.deps.staff.findById(challenge.s);
    if (!staff || staff.disabledAt || fingerprint(staff) !== challenge.f) throw new AppError('INVALID_TOKEN', 401, 'Sign in again.');
    this.assertNotLocked(staff);
    if (challenge.m === 'enroll' && staff.mfaEnabledAt) throw new AppError('INVALID_TOKEN', 401, 'Two-factor authentication is already set up. Sign in again.');
    if (challenge.m === 'verify' && (!staff.mfaEnabledAt || !staff.mfaSecret)) throw new AppError('INVALID_TOKEN', 401, 'Sign in again.');

    const secret = challenge.m === 'enroll' ? challenge.k! : this.deps.cipher.decrypt('staff-mfa', staff.mfaSecret!);
    const step = verifyTotp(secret, input.code.trim(), this.now(), staff.mfaLastStep);
    if (step === null) {
      const locked = await this.deps.staff.recordMfaFailure(staff.id, MFA_FAILURE_LIMIT, new Date(this.now() + MFA_LOCK_MS));
      void this.auditFailure(staff, locked ? 'mfa_locked' : 'mfa', context);
      if (locked) throw lockedError(MFA_LOCK_MS);
      throw new AppError('MFA_INVALID', 401, 'The code is not valid. Check the time on your device and try again.');
    }

    const token = randomBytes(32).toString('base64url');
    const now = this.deps.clock.now();
    const idleExpiresAt = new Date(now.getTime() + this.deps.config.idleTimeoutMs);
    const sessionId = newEntityId();
    const updated = await this.deps.uow.run(async (tx) => {
      // Atomic: the same code cannot open two sessions, even on two instances at once.
      if (!(await tx.staff.claimMfaStep(staff.id, step))) throw new AppError('MFA_INVALID', 401, 'This code was already used. Wait for the next one.');
      // Only the first enrolment wins: a parallel one cannot replace a secret that was just set up.
      if (challenge.m === 'enroll' && !(await tx.staff.enrollMfa(staff.id, this.deps.cipher.encrypt('staff-mfa', secret), now))) {
        throw new AppError('INVALID_TOKEN', 401, 'Two-factor authentication is already set up. Sign in again.');
      }
      await tx.staff.resetMfaFailures(staff.id);
      const record = await tx.staff.update(staff.id, { lastLoginAt: now }, now);
      await tx.staffSessions.create({
        id: sessionId,
        staffId: staff.id,
        tokenHash: hashToken(token),
        ip: context.ip,
        userAgent: context.userAgent?.slice(0, 200) ?? null,
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt,
        absoluteExpiresAt: new Date(now.getTime() + this.deps.config.absoluteTimeoutMs),
      });
      if (challenge.m === 'enroll') await tx.audit.append({ ...this.entry(staff, context, 'staff.mfa_enrolled'), details: {} });
      await tx.audit.append({ ...this.entry(staff, context, 'staff.login'), details: { userAgent: context.userAgent?.slice(0, 200) ?? null } });
      await tx.outbox.enqueue({ id: newEntityId(), topic: 'staff.signed_in', payload: { staffId: staff.id, email: staff.email, ip: context.ip, at: now.toISOString() }, now });
      return record!;
    });
    this.deps.jobs?.kick(OUTBOX_JOB);
    return { token, expiresAt: idleExpiresAt.toISOString(), me: toMeDto(toPrincipal(updated, sessionId)) };
  }

  async authenticate(token: string): Promise<StaffPrincipal | null> {
    if (!TOKEN_FORMAT.test(token)) return null;
    const found = await this.deps.sessions.findByTokenHash(hashToken(token));
    if (!found) return null;
    const { session, staff } = found;
    const now = this.now();
    if (staff.disabledAt || session.idleExpiresAt.getTime() <= now || session.absoluteExpiresAt.getTime() <= now) return null;
    if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const idle = Math.min(now + this.deps.config.idleTimeoutMs, session.absoluteExpiresAt.getTime());
      this.deps.sessions.touch(session.id, new Date(now), new Date(idle)).catch((error: unknown) => this.deps.logger.warn({ err: error }, 'Failed to touch staff session'));
    }
    return toPrincipal(staff, session.id);
  }

  async logout(principal: StaffPrincipal, context: AdminContext): Promise<void> {
    await this.deps.uow.run(async (tx) => {
      await tx.staffSessions.delete(principal.sessionId);
      await tx.audit.append({ ...this.entry(principal, context, 'staff.logout'), details: {} });
    });
  }

  async changePassword(principal: StaffPrincipal, input: { currentPassword: string; newPassword: string }, context: AdminContext): Promise<void> {
    const staff = await this.deps.staff.findById(principal.id);
    if (!staff || !(await this.deps.hasher.verify(input.currentPassword, staff.passwordHash))) throw new AppError('INVALID_CREDENTIALS', 401, 'Current password is incorrect.');
    const problem = passwordProblem(input.newPassword, staff.email) ?? (input.newPassword.length < 12 ? 'Console passwords must be at least 12 characters.' : null);
    if (problem) throw AppError.validation(problem, [{ path: 'newPassword', message: problem }]);
    if (await this.deps.hasher.verify(input.newPassword, staff.passwordHash)) throw AppError.validation('Choose a new password, not the current one.');
    const passwordHash = await this.deps.hasher.hash(input.newPassword);
    await this.deps.uow.run(async (tx) => {
      await tx.staff.update(staff.id, { passwordHash, mustChangePassword: false }, this.deps.clock.now());
      // Other devices signed in with the old password are signed out.
      const signedOut = await tx.staffSessions.deleteForStaff(staff.id, principal.sessionId);
      await tx.audit.append({ ...this.entry(principal, context, 'staff.password_changed'), details: { otherSessionsSignedOut: signedOut } });
    });
  }

  purgeExpiredSessions(): Promise<number> {
    return this.deps.sessions.purgeExpired(this.deps.clock.now());
  }

  // ---------------------------------------------------------------------------------------

  private assertNotLocked(staff: StaffWithPassword): void {
    const remaining = (staff.lockedUntil?.getTime() ?? 0) - this.now();
    if (remaining > 0) throw lockedError(remaining);
  }

  private async auditFailure(staff: StaffWithPassword, reason: 'password' | 'disabled' | 'mfa' | 'mfa_locked', context: AdminContext): Promise<void> {
    try {
      await this.deps.uow.run((tx) => tx.audit.append({ ...this.entry(staff, context, 'staff.login_failed'), details: { reason } }));
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'Failed to audit a failed console sign-in');
    }
  }

  private entry(staff: { id: string; email: string }, context: AdminContext, action: string) {
    return { ...actorOf(staff, context), occurredAt: this.deps.clock.now(), action, targetType: 'staff', targetId: staff.id, beforeHash: null, afterHash: null };
  }

  private seal(challenge: Challenge): string {
    return this.deps.cipher.encrypt('staff-challenge', JSON.stringify(challenge));
  }

  private open(sealed: string): Challenge {
    let challenge: Challenge;
    try {
      challenge = JSON.parse(this.deps.cipher.decrypt('staff-challenge', sealed)) as Challenge;
    } catch {
      throw new AppError('INVALID_TOKEN', 401, 'Sign in again.');
    }
    if (typeof challenge.s !== 'string' || typeof challenge.e !== 'number' || typeof challenge.f !== 'string' || challenge.e < this.now()) throw new AppError('INVALID_TOKEN', 401, 'The sign-in step expired. Sign in again.');
    if (challenge.m === 'enroll' && typeof challenge.k !== 'string') throw new AppError('INVALID_TOKEN', 401, 'Sign in again.');
    return challenge;
  }

  private now(): number {
    return this.deps.clock.now().getTime();
  }
}

function lockedError(ms: number): AppError {
  return new AppError('RATE_LIMITED', 429, `Too many wrong codes. The account is locked for ${Math.ceil(ms / 60_000)} minutes.`);
}

/** Changes whenever the password or the 2FA secret changes. */
function fingerprint(staff: StaffWithPassword): string {
  return createHash('sha256').update(`${staff.passwordHash}|${staff.mfaSecret ?? ''}|${staff.mfaEnabledAt?.getTime() ?? ''}`).digest('base64url').slice(0, 16);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

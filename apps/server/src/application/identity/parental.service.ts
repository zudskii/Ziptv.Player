import type { ParentalSettingsDto, ProfileDto, UnlockDto, UpdateParentalRulesRequest } from '@ziptv/contracts';

import {
  isTrivialPin,
  isValidPin,
  MAX_LOCKED_ITEMS,
  MAX_PIN_FAILURES,
  NO_RULES,
  normaliseLocks,
  OPERATOR_LOCK_SOURCE,
  PIN_LOCK_MS,
  type ParentalRules,
} from '../../domain/viewer/parental.js';
import { AppError } from '../errors.js';
import type { Cache } from '../ports/cache.js';
import type { Clock } from '../ports/clock.js';
import type { ParentalPinRecord, ParentalRepository } from '../ports/parental-repository.js';
import type { PasswordHasher } from '../ports/password-hasher.js';
import type { ProfileRecord, ProfileRepository } from '../ports/profile-repository.js';
import type { SessionRepository } from '../ports/session-repository.js';
import type { SourceRepository } from '../ports/source-repository.js';
import type { UnlockTokens } from '../ports/unlock-tokens.js';
import type { NotificationService } from '../notifications/notification.service.js';
import { invalidateHome } from '../user-state/cache-keys.js';
import { toProfileDto, type ProfileService } from './profile.service.js';
import type { AuthUser } from './session.service.js';
import { lockKey, type Viewer } from './viewer.js';

const STATE_TTL_MS = 10_000;
const stateKey = (userId: string) => `parental:${userId}`;

interface ParentalState {
  pin: { version: number } | null;
  rules: Map<string, ParentalRules>;
}

/**
 * Parental controls (Phase 10.5), enforced on the server: every request's Viewer carries the
 * profile's restrictions, and lists, search, Home, EPG and playback all read them from there.
 *
 *  - One PIN per account (scrypt-hashed, 5 wrong attempts → locked for 15 minutes).
 *  - Per profile: hide adult, locked groups and channels (BYO sources and the operator catalog).
 *  - Unlock: the PIN yields a short-lived token bound to the device, profile and PIN version.
 *  - PIN-protected profiles and the kids lock live on the device session: a protected profile is
 *    opened with the PIN; a device that entered a kids profile stays there until the PIN is given.
 *  - Kids profiles are strict: locked and adult content is filtered out (never "locked"), the PIN
 *    never unlocks content there, and rules / PIN cannot be changed from a kids profile.
 */
export class ParentalService {
  constructor(
    private readonly deps: {
      parental: ParentalRepository;
      profiles: Pick<ProfileService, 'records' | 'forget'>;
      profileStore: Pick<ProfileRepository, 'update' | 'clearPinProtection'>;
      sessions: Pick<SessionRepository, 'setProfileGate' | 'clearProfileGates'>;
      sources: Pick<SourceRepository, 'listByOwner'>;
      hasher: PasswordHasher;
      tokens: UnlockTokens;
      cache: Cache;
      clock: Clock;
      unlockTtlSeconds: number;
      /** Security notices to the account (PIN set, changed, removed, locked by wrong guesses). */
      notifications?: Pick<NotificationService, 'notify'>;
    },
  ) {}

  private notice(userId: string, severity: 'info' | 'warning', title: string, body: string): Promise<void> {
    return this.deps.notifications?.notify({ ownerId: userId, type: 'account_security', severity, title, body, link: '/settings#parental', dedupeKey: `parental:${title}` }) ?? Promise.resolve();
  }

  // --- the Viewer of a request ---------------------------------------------------------------------

  /**
   * Viewer of a request: `X-Profile-Id` (else the device's kids profile, else the default profile)
   * with its restrictions. Refuses a profile the device may not open without the PIN.
   */
  async viewerFor(user: AuthUser, input: { profileId?: string | undefined; unlockToken?: string | undefined }): Promise<Viewer> {
    const [profiles, state] = await Promise.all([this.deps.profiles.records(user.id), this.state(user.id)]);
    const kidsLock = state.pin && user.kidsLockProfileId ? profiles.find((item) => item.id === user.kidsLockProfileId) : undefined;
    const wanted = input.profileId ?? kidsLock?.id;
    const profile = wanted ? profiles.find((item) => item.id === wanted) : profiles.find((item) => item.isDefault);
    if (!profile) throw new AppError('NOT_FOUND', 404, 'Profile not found.', { reason: 'profile' });
    this.assertOpen(user, profile, kidsLock, state);

    const kids = profile.kind === 'kids';
    const rules = state.rules.get(profile.id) ?? NO_RULES;
    let unlocked = false;
    if (!kids && state.pin && input.unlockToken && user.sessionId) {
      const claims = this.deps.tokens.verify(input.unlockToken, this.nowSeconds());
      unlocked = !!claims && claims.userId === user.id && claims.sessionId === user.sessionId && claims.profileId === profile.id && claims.pinVersion === state.pin.version;
    }
    return {
      userId: user.id,
      sessionId: user.sessionId,
      profileId: profile.id,
      kids,
      hideAdult: kids || rules.hideAdult,
      // Locks need a PIN to mean anything (and to be lifted).
      lockedGroups: new Set(state.pin ? rules.lockedGroups.map((item) => lockKey(item.sourceId, item.group)) : []),
      lockedChannels: new Set(state.pin ? rules.lockedChannels.map((item) => lockKey(item.sourceId, item.key)) : []),
      unlocked,
      // Shared caches (VOD overview per source) key on this: profiles with their own rules never share.
      restrictionsVersion: `${profile.kind}.${rules === NO_RULES ? '0' : `${profile.id}@${rules.updatedAt.getTime().toString(36)}`}.${state.pin?.version ?? 0}`,
    };
  }

  private assertOpen(user: AuthUser, profile: ProfileRecord, kidsLock: ProfileRecord | undefined, state: ParentalState): void {
    if (kidsLock && profile.id !== kidsLock.id) {
      throw new AppError('PIN_REQUIRED', 403, 'This device is in a kids profile. Enter the PIN to switch profiles.', { reason: 'kids_lock', profileId: kidsLock.id });
    }
    if (state.pin && profile.pinProtected && user.openProfileId !== profile.id) {
      throw new AppError('PIN_REQUIRED', 403, 'This profile is protected. Enter the PIN to open it.', { reason: 'profile_locked', profileId: profile.id });
    }
  }

  /**
   * Opening a profile on this device (`POST /profiles/:id/access`). The PIN is needed to leave a
   * kids lock and to open a protected profile; entering a kids profile locks the device to it.
   */
  async openProfile(user: AuthUser, profileId: string, pin: string | undefined): Promise<ProfileDto> {
    const [profiles, state] = await Promise.all([this.deps.profiles.records(user.id), this.state(user.id)]);
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw AppError.notFound('Profile');
    const kidsLock = state.pin && user.kidsLockProfileId ? profiles.find((item) => item.id === user.kidsLockProfileId) : undefined;
    const leavingKids = !!kidsLock && kidsLock.id !== profile.id;
    const protectedProfile = !!state.pin && profile.pinProtected && user.openProfileId !== profile.id;
    if (leavingKids || protectedProfile) {
      if (!pin) {
        throw new AppError('PIN_REQUIRED', 403, leavingKids ? 'Enter the PIN to leave the kids profile.' : 'This profile is protected. Enter the PIN to open it.', {
          reason: leavingKids ? 'kids_lock' : 'profile_locked',
          profileId: leavingKids ? kidsLock!.id : profile.id,
        });
      }
      await this.verifyPin(user.id, pin);
    }
    await this.deps.sessions.setProfileGate(user.sessionId, user.id, {
      kidsLockProfileId: state.pin && profile.kind === 'kids' ? profile.id : null,
      openProfileId: profile.pinProtected ? profile.id : null,
    });
    return toProfileDto(profile);
  }

  // --- PIN ---------------------------------------------------------------------------------------

  async setPin(viewer: Viewer, input: { currentPin?: string | undefined; pin: string }): Promise<ParentalSettingsDto> {
    this.refuseKids(viewer);
    if (!isValidPin(input.pin)) throw AppError.validation('The PIN must be 4 to 8 digits.');
    if (isTrivialPin(input.pin)) throw AppError.validation('Choose a PIN that is harder to guess than a repeated digit or a straight run.');
    const existing = await this.deps.parental.findPin(viewer.userId);
    if (existing) {
      if (!input.currentPin) throw new AppError('PIN_REQUIRED', 403, 'Enter the current PIN to change it.', { reason: 'pin_change' });
      await this.verifyPin(viewer.userId, input.currentPin);
    }
    await this.deps.parental.savePin(viewer.userId, await this.deps.hasher.hash(input.pin), this.deps.clock.now());
    this.forget(viewer.userId);
    await this.notice(viewer.userId, 'info', existing ? 'Parental PIN changed' : 'Parental PIN set', existing ? 'Unlocks made with the old PIN no longer work.' : 'Locked content and protected profiles now need this PIN.');
    return this.settings(viewer);
  }

  /** Removes the PIN: content locks, protected profiles and kids locks go with it. */
  async removePin(viewer: Viewer, pin: string): Promise<ParentalSettingsDto> {
    this.refuseKids(viewer);
    await this.verifyPin(viewer.userId, pin);
    const now = this.deps.clock.now();
    await this.deps.parental.clearLocks(viewer.userId, now);
    await this.deps.profileStore.clearPinProtection(viewer.userId);
    await this.deps.sessions.clearProfileGates(viewer.userId);
    await this.deps.parental.deletePin(viewer.userId);
    this.deps.profiles.forget(viewer.userId);
    this.forget(viewer.userId);
    await this.notice(viewer.userId, 'warning', 'Parental PIN removed', 'Content locks and profile protection were turned off.');
    return this.settings({ ...viewer, lockedGroups: new Set(), lockedChannels: new Set() });
  }

  /** PIN → unlock token for locked content of this profile on this device (never for kids). */
  async unlock(viewer: Viewer, pin: string): Promise<UnlockDto> {
    if (viewer.kids) throw new AppError('FORBIDDEN', 403, 'Locked content stays locked in a kids profile.', { reason: 'kids_profile' });
    if (!viewer.sessionId) throw AppError.unauthorized();
    const record = await this.verifyPin(viewer.userId, pin);
    const expiresAt = this.nowSeconds() + this.deps.unlockTtlSeconds;
    const token = this.deps.tokens.issue({ userId: viewer.userId, sessionId: viewer.sessionId, profileId: viewer.profileId, pinVersion: record.version, expiresAt });
    return { token, expiresAt: new Date(expiresAt * 1000).toISOString() };
  }

  /**
   * Checks a PIN, counting failures (5 → locked for 15 minutes). A correct PIN while locked is
   * still refused: the lock is what stops guessing.
   */
  async verifyPin(userId: string, pin: string): Promise<ParentalPinRecord> {
    const record = await this.deps.parental.findPin(userId);
    if (!record) throw new AppError('CONFLICT', 409, 'No parental PIN is set.', { reason: 'no_pin' });
    const now = this.deps.clock.now();
    if (record.lockedUntil && record.lockedUntil > now) {
      throw new AppError('RATE_LIMITED', 429, 'Too many wrong PINs. Try again later.', { reason: 'pin_locked', lockedUntil: record.lockedUntil.toISOString() });
    }
    const ok = isValidPin(pin) && (await this.deps.hasher.verify(pin, record.pinHash));
    if (!ok) {
      const next = await this.deps.parental.registerFailure(userId, MAX_PIN_FAILURES, new Date(now.getTime() + PIN_LOCK_MS));
      if (next.lockedUntil) await this.notice(userId, 'warning', 'Parental PIN locked', 'Several wrong PINs were entered; the PIN is locked for 15 minutes.');
      if (next.lockedUntil) throw new AppError('RATE_LIMITED', 429, 'Too many wrong PINs. Try again later.', { reason: 'pin_locked', lockedUntil: next.lockedUntil.toISOString() });
      throw new AppError('PIN_INVALID', 403, 'Wrong PIN.', { reason: 'pin_invalid' });
    }
    if (record.failures > 0 || record.lockedUntil) await this.deps.parental.clearFailures(userId);
    return record;
  }

  /** Changes that a kids profile or someone without the PIN must not make (profile kind, protection, deletion). */
  async requirePin(user: AuthUser, pin: string | undefined, action: string): Promise<void> {
    const state = await this.state(user.id);
    if (!state.pin) return;
    if (!pin) throw new AppError('PIN_REQUIRED', 403, `Enter the parental PIN to ${action}.`, { reason: 'pin_required' });
    await this.verifyPin(user.id, pin);
  }

  /** True when this device is held in a kids profile. */
  async kidsLocked(user: AuthUser): Promise<boolean> {
    return !!user.kidsLockProfileId && !!(await this.state(user.id)).pin;
  }

  async keepOpen(user: AuthUser, profileId: string): Promise<void> {
    await this.deps.sessions.setProfileGate(user.sessionId, user.id, { openProfileId: profileId });
  }

  async hasPin(userId: string): Promise<boolean> {
    return !!(await this.state(userId)).pin;
  }

  // --- rules -------------------------------------------------------------------------------------

  /** The rules of the viewer's profile, or (grown-up profiles only) of another profile of the account. */
  async settings(viewer: Viewer, profileId?: string): Promise<ParentalSettingsDto> {
    const state = await this.state(viewer.userId);
    let kids = viewer.kids;
    if (profileId && profileId !== viewer.profileId) {
      this.refuseKids(viewer);
      const profile = (await this.deps.profiles.records(viewer.userId)).find((item) => item.id === profileId);
      if (!profile) throw AppError.notFound('Profile');
      kids = profile.kind === 'kids';
    }
    const rules = state.rules.get(profileId ?? viewer.profileId) ?? NO_RULES;
    return {
      pinSet: !!state.pin,
      hideAdult: kids || rules.hideAdult,
      lockedGroups: rules.lockedGroups,
      lockedChannels: rules.lockedChannels,
    };
  }

  /** Rules of a profile (the current one unless `profileId`), PIN required, never from a kids profile. */
  async updateRules(viewer: Viewer, input: UpdateParentalRulesRequest & { profileId?: string | undefined }): Promise<ParentalSettingsDto> {
    this.refuseKids(viewer);
    await this.verifyPin(viewer.userId, input.pin);
    const targetId = input.profileId ?? viewer.profileId;
    const profiles = await this.deps.profiles.records(viewer.userId);
    if (!profiles.some((profile) => profile.id === targetId)) throw AppError.notFound('Profile');

    const current = (await this.state(viewer.userId)).rules.get(targetId) ?? NO_RULES;
    const groups = input.lockedGroups ?? current.lockedGroups;
    const channels = input.lockedChannels?.map((item) => ({ sourceId: item.sourceId, key: item.key, name: item.name ?? item.key })) ?? current.lockedChannels;
    if (groups.length > MAX_LOCKED_ITEMS || channels.length > MAX_LOCKED_ITEMS) throw AppError.validation(`At most ${MAX_LOCKED_ITEMS} locked groups and ${MAX_LOCKED_ITEMS} locked channels.`);
    const owned = new Set((await this.deps.sources.listByOwner(viewer.userId)).map((source) => source.id));
    const foreign = [...groups, ...channels].find((item) => item.sourceId !== OPERATOR_LOCK_SOURCE && !owned.has(item.sourceId));
    if (foreign) throw AppError.validation('A lock names a source that is not yours.');

    const locks = normaliseLocks(groups, channels);
    await this.deps.parental.saveRules(targetId, { hideAdult: input.hideAdult ?? current.hideAdult, ...locks }, this.deps.clock.now());
    this.forget(viewer.userId);
    invalidateHome(this.deps.cache, targetId);
    const target = profiles.find((profile) => profile.id === targetId)!;
    return this.settings({ ...viewer, profileId: targetId, kids: target.kind === 'kids' });
  }

  // ---------------------------------------------------------------------------------------------

  private async state(userId: string): Promise<ParentalState> {
    return this.deps.cache.wrap(stateKey(userId), STATE_TTL_MS, async () => {
      const [pin, rules] = await Promise.all([this.deps.parental.findPin(userId), this.deps.parental.rulesOf(userId)]);
      return { pin: pin ? { version: pin.version } : null, rules };
    });
  }

  forget(userId: string): void {
    this.deps.cache.delete(stateKey(userId));
  }

  private refuseKids(viewer: Viewer): void {
    if (viewer.kids) throw new AppError('FORBIDDEN', 403, 'Parental controls cannot be changed from a kids profile.', { reason: 'kids_profile' });
  }

  private nowSeconds(): number {
    return Math.floor(this.deps.clock.now().getTime() / 1000);
  }
}

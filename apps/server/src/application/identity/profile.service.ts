import type { CreateProfileRequest, ParentalSettingsDto, ProfileDto, SettingsDto, UpdateProfileRequest, UpdateSettingsRequest } from '@ziptv/contracts';

import { DEFAULT_PROFILE_NAME, MAX_PROFILES, nextProfileColor, normalizeProfileName, isProfileColor } from '../../domain/viewer/profile.js';
import { applySettingsPatch, resolveSettings, toStoredSettings, type ProfileSettings } from '../../domain/viewer/settings.js';
import { AppError } from '../errors.js';
import { invalidateHome } from '../user-state/cache-keys.js';
import type { Cache } from '../ports/cache.js';
import type { ProfileRecord, ProfileRepository } from '../ports/profile-repository.js';
import type { AuthUser } from './session.service.js';
import type { Viewer } from './viewer.js';

const PROFILES_TTL_MS = 30_000;
const profilesKey = (userId: string) => `profiles:${userId}`;

/** What profile changes need from parental controls (PIN checks, the device's kids lock). */
export interface ProfileGuard {
  requirePin(user: AuthUser, pin: string | undefined, action: string): Promise<void>;
  kidsLocked(user: AuthUser): Promise<boolean>;
  hasPin(userId: string): Promise<boolean>;
  settings(viewer: Viewer): Promise<ParentalSettingsDto>;
  /** The device that just protected a profile (with the PIN) keeps it open. */
  keepOpen(user: AuthUser, profileId: string): Promise<void>;
}

/**
 * Profiles of an account and their settings. Every account has a default profile (created on
 * first use); requests choose another with `X-Profile-Id`. With a parental PIN set, changing a
 * profile's kind or protection and deleting a profile need the PIN, and a device held in a kids
 * profile cannot add profiles without it.
 */
export class ProfileService {
  constructor(
    private readonly deps: {
      profiles: ProfileRepository;
      cache: Cache;
      limits?: { maxProfiles: number };
    },
  ) {}

  private guard: ProfileGuard | null = null;

  /** Parental controls are built on top of profiles; they plug their checks in here. */
  useGuard(guard: ProfileGuard): void {
    this.guard = guard;
  }

  private get maxProfiles(): number {
    return this.deps.limits?.maxProfiles ?? MAX_PROFILES;
  }

  /** Cached per user (every request resolves its viewer through this). */
  async records(userId: string): Promise<ProfileRecord[]> {
    return this.deps.cache.wrap(profilesKey(userId), PROFILES_TTL_MS, async () => {
      let profiles = await this.deps.profiles.listByUser(userId);
      if (!profiles.some((profile) => profile.isDefault)) {
        await this.deps.profiles.ensureDefault(userId, { id: this.deps.profiles.newId(), name: DEFAULT_PROFILE_NAME, color: nextProfileColor(profiles.map((p) => p.color)) });
        profiles = await this.deps.profiles.listByUser(userId);
      }
      return profiles;
    });
  }

  /** The account's profiles; `heldHere` marks the kids profile this device is held in. */
  async list(user: AuthUser | string): Promise<ProfileDto[]> {
    const userId = typeof user === 'string' ? user : user.id;
    const held = typeof user !== 'string' && this.guard && (await this.guard.kidsLocked(user)) ? user.kidsLockProfileId : null;
    return (await this.records(userId)).map((profile) => ({ ...toProfileDto(profile), ...(held === profile.id ? { heldHere: true } : {}) }));
  }

  async create(user: AuthUser, input: CreateProfileRequest & { pin?: string | undefined }): Promise<ProfileDto> {
    const userId = user.id;
    if (this.guard && (await this.guard.kidsLocked(user))) await this.guard.requirePin(user, input.pin, 'add a profile');
    if (input.pinProtected && !(await this.guard?.hasPin(userId))) throw AppError.validation('Set a parental PIN first to protect a profile.');
    const existing = await this.records(userId);
    const name = this.validName(input.name);
    if (input.color !== undefined && !isProfileColor(input.color)) throw AppError.validation('Colour must be a #rrggbb value.');
    const created = await this.deps.profiles.create(
      { id: this.deps.profiles.newId(), userId, name, color: input.color ?? nextProfileColor(existing.map((profile) => profile.color)), kind: input.kind ?? 'standard' },
      this.maxProfiles,
    );
    if (!created) {
      this.forget(userId);
      throw new AppError('PROFILE_LIMIT_REACHED', 409, `An account can have up to ${this.maxProfiles} profiles.`);
    }
    const result = input.pinProtected ? ((await this.deps.profiles.update(created.id, userId, { pinProtected: true })) ?? created) : created;
    this.forget(userId);
    return toProfileDto(result);
  }

  async update(user: AuthUser, profileId: string, input: UpdateProfileRequest & { pin?: string | undefined }): Promise<ProfileDto> {
    const userId = user.id;
    if (input.color !== undefined && !isProfileColor(input.color)) throw AppError.validation('Colour must be a #rrggbb value.');
    const current = (await this.records(userId)).find((item) => item.id === profileId);
    if (!current) throw AppError.notFound('Profile');
    const kindChange = input.kind !== undefined && input.kind !== current.kind;
    const protectionChange = input.pinProtected !== undefined && input.pinProtected !== current.pinProtected;
    // A child must not turn their profile into a grown-up one, or lift a protection.
    if (this.guard && (kindChange || protectionChange)) await this.guard.requirePin(user, input.pin, 'change this profile');
    if (input.pinProtected && !(await this.guard?.hasPin(userId))) throw AppError.validation('Set a parental PIN first to protect a profile.');
    const updated = await this.deps.profiles.update(profileId, userId, {
      ...(input.name !== undefined ? { name: this.validName(input.name) } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.pinProtected !== undefined ? { pinProtected: input.pinProtected } : {}),
    });
    this.forget(userId);
    if (!updated) throw AppError.notFound('Profile');
    if (protectionChange && updated.pinProtected) await this.guard?.keepOpen(user, updated.id);
    return toProfileDto(updated);
  }

  async remove(user: AuthUser, profileId: string, pin?: string): Promise<void> {
    const userId = user.id;
    const profile = (await this.records(userId)).find((item) => item.id === profileId);
    if (!profile) throw AppError.notFound('Profile');
    if (profile.isDefault) throw new AppError('CONFLICT', 409, 'The main profile cannot be deleted.');
    if (this.guard) await this.guard.requirePin(user, pin, 'delete a profile');
    await this.deps.profiles.delete(profileId, userId);
    this.forget(userId);
  }

  // --- settings ------------------------------------------------------------------------------

  async settingsOf(viewer: Viewer): Promise<ProfileSettings> {
    const profile = (await this.records(viewer.userId)).find((item) => item.id === viewer.profileId);
    return resolveSettings(profile?.settings);
  }

  async settings(viewer: Viewer): Promise<SettingsDto> {
    return toSettingsDto(await this.settingsOf(viewer), await this.parentalOf(viewer));
  }

  private async parentalOf(viewer: Viewer): Promise<ParentalSettingsDto> {
    return this.guard ? this.guard.settings(viewer) : { pinSet: false, hideAdult: viewer.hideAdult, lockedGroups: [], lockedChannels: [] };
  }

  async updateSettings(viewer: Viewer, patch: UpdateSettingsRequest): Promise<SettingsDto> {
    // Patched against the stored row under a lock (not the cached list): concurrent changes merge.
    let settings: ProfileSettings | null = null;
    const saved = await this.deps.profiles.changeSettings(viewer.profileId, viewer.userId, (stored) => {
      const result = applySettingsPatch(resolveSettings(stored), patch);
      if (result.invalid.length > 0) throw AppError.validation('Some settings have invalid values.', { fields: result.invalid });
      settings = result.settings;
      return toStoredSettings(result.settings);
    });
    this.forget(viewer.userId);
    // Home rails depend on settings (EPG time shift).
    invalidateHome(this.deps.cache, viewer.profileId);
    if (!saved || !settings) throw AppError.notFound('Profile');
    return toSettingsDto(settings, await this.parentalOf(viewer));
  }

  forget(userId: string): void {
    this.deps.cache.delete(profilesKey(userId));
  }

  private validName(raw: string): string {
    const name = normalizeProfileName(raw);
    if (!name) throw AppError.validation('Give the profile a name.');
    return name;
  }
}

export function toProfileDto(profile: ProfileRecord): ProfileDto {
  return {
    id: profile.id,
    name: profile.name,
    color: profile.color,
    kind: profile.kind,
    isDefault: profile.isDefault,
    pinProtected: profile.pinProtected,
    createdAt: profile.createdAt.toISOString(),
  };
}

function toSettingsDto(settings: ProfileSettings, parental: ParentalSettingsDto): SettingsDto {
  // Parental controls (PIN, locks) are managed through /me/parental; reported here read-only.
  return { ...settings, parental };
}

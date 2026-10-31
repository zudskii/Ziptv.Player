import type { CreateProfileRequest, ProfileDto, SettingsDto, UpdateProfileRequest, UpdateSettingsRequest } from '@ziptv/contracts';

import { DEFAULT_PROFILE_NAME, MAX_PROFILES, nextProfileColor, normalizeProfileName, isProfileColor } from '../../domain/viewer/profile.js';
import { applySettingsPatch, resolveSettings, toStoredSettings, type ProfileSettings } from '../../domain/viewer/settings.js';
import { AppError } from '../errors.js';
import { invalidateHome } from '../user-state/cache-keys.js';
import type { Cache } from '../ports/cache.js';
import type { ProfileRecord, ProfileRepository } from '../ports/profile-repository.js';
import type { Viewer } from './viewer.js';

const PROFILES_TTL_MS = 30_000;
const profilesKey = (userId: string) => `profiles:${userId}`;

/**
 * Profiles of an account and their settings. Every account has a default profile (created on
 * first use); requests choose another with `X-Profile-Id`. Parental PIN protection of profiles
 * arrives with parental controls — until then `pinProtected` is always false.
 */
export class ProfileService {
  constructor(
    private readonly deps: {
      profiles: ProfileRepository;
      cache: Cache;
      limits?: { maxProfiles: number };
    },
  ) {}

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

  async list(userId: string): Promise<ProfileDto[]> {
    return (await this.records(userId)).map(toProfileDto);
  }

  async create(userId: string, input: CreateProfileRequest): Promise<ProfileDto> {
    const existing = await this.records(userId);
    const name = this.validName(input.name);
    if (input.color !== undefined && !isProfileColor(input.color)) throw AppError.validation('Colour must be a #rrggbb value.');
    const created = await this.deps.profiles.create(
      { id: this.deps.profiles.newId(), userId, name, color: input.color ?? nextProfileColor(existing.map((profile) => profile.color)), kind: input.kind ?? 'standard' },
      this.maxProfiles,
    );
    this.forget(userId);
    if (!created) throw new AppError('PROFILE_LIMIT_REACHED', 409, `An account can have up to ${this.maxProfiles} profiles.`);
    return toProfileDto(created);
  }

  async update(userId: string, profileId: string, input: UpdateProfileRequest): Promise<ProfileDto> {
    if (input.color !== undefined && !isProfileColor(input.color)) throw AppError.validation('Colour must be a #rrggbb value.');
    const updated = await this.deps.profiles.update(profileId, userId, {
      ...(input.name !== undefined ? { name: this.validName(input.name) } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
    });
    this.forget(userId);
    if (!updated) throw AppError.notFound('Profile');
    return toProfileDto(updated);
  }

  async remove(userId: string, profileId: string): Promise<void> {
    const profile = (await this.records(userId)).find((item) => item.id === profileId);
    if (!profile) throw AppError.notFound('Profile');
    if (profile.isDefault) throw new AppError('CONFLICT', 409, 'The main profile cannot be deleted.');
    await this.deps.profiles.delete(profileId, userId);
    this.forget(userId);
  }

  /** Selecting a profile (the client then sends `X-Profile-Id`). */
  async access(userId: string, profileId: string): Promise<ProfileDto> {
    const profile = (await this.records(userId)).find((item) => item.id === profileId);
    if (!profile) throw AppError.notFound('Profile');
    return toProfileDto(profile);
  }

  // --- settings ------------------------------------------------------------------------------

  async settingsOf(viewer: Viewer): Promise<ProfileSettings> {
    const profile = (await this.records(viewer.userId)).find((item) => item.id === viewer.profileId);
    return resolveSettings(profile?.settings);
  }

  async settings(viewer: Viewer): Promise<SettingsDto> {
    return toSettingsDto(await this.settingsOf(viewer), viewer);
  }

  async updateSettings(viewer: Viewer, patch: UpdateSettingsRequest): Promise<SettingsDto> {
    const { settings, invalid } = applySettingsPatch(await this.settingsOf(viewer), patch);
    if (invalid.length > 0) throw AppError.validation('Some settings have invalid values.', { fields: invalid });
    const saved = await this.deps.profiles.saveSettings(viewer.profileId, viewer.userId, toStoredSettings(settings));
    this.forget(viewer.userId);
    // Home rails depend on settings (EPG time shift).
    invalidateHome(this.deps.cache, viewer.profileId);
    if (!saved) throw AppError.notFound('Profile');
    return toSettingsDto(settings, viewer);
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
    pinProtected: false,
    createdAt: profile.createdAt.toISOString(),
  };
}

function toSettingsDto(settings: ProfileSettings, viewer: Viewer): SettingsDto {
  return {
    ...settings,
    // Parental controls (PIN, locks) are managed separately; reported here read-only.
    parental: { pinSet: false, hideAdult: viewer.hideAdult, lockedGroups: [], lockedChannels: [] },
  };
}

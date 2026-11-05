import type { ProfileLibraryDto, SourceProfilesDto } from '@ziptv/contracts';

import { AppError } from '../errors.js';
import type { Cache } from '../ports/cache.js';
import type { LibraryRepository } from '../ports/library-repository.js';
import type { ProfileRecord } from '../ports/profile-repository.js';
import type { SourceRepository } from '../ports/source-repository.js';
import { invalidateHome } from '../user-state/cache-keys.js';
import type { ProfileGuard } from './profile.service.js';
import type { AuthUser } from './session.service.js';
import type { Viewer } from './viewer.js';

const LIBRARY_TTL_MS = 30_000;
export const libraryKey = (userId: string) => `library:${userId}`;

/** Who sees a new source: the profile that added it, or every grown-up profile of the account. */
export type NewSourceAudience = 'profile' | 'all';

/**
 * Per-profile library: the account owns its sources (one copy of the credentials, one connection
 * budget per Xtream account) and each profile sees the ones assigned to it.
 *
 *  - A new source goes to the profile that added it, or (`all`) to every standard profile. Kids
 *    profiles only ever see what a grown-up assigned to them explicitly.
 *  - A new standard profile starts with all of the account's sources (as before profiles had
 *    libraries); a new kids profile starts empty.
 *  - Changing a kids profile's library, or any library from a device held in a kids profile, needs
 *    the parental PIN (when one is set) — a child must not widen what they can watch.
 */
export class LibraryService {
  constructor(
    private readonly deps: {
      library: LibraryRepository;
      sources: Pick<SourceRepository, 'listByOwner'>;
      profiles: { records(userId: string): Promise<ProfileRecord[]> };
      cache: Cache;
    },
  ) {}

  private guard: Pick<ProfileGuard, 'requirePin' | 'kidsLocked'> | null = null;

  useGuard(guard: Pick<ProfileGuard, 'requirePin' | 'kidsLocked'>): void {
    this.guard = guard;
  }

  /** Profile id → the sources it sees. Cached per account; every request's Viewer is built from it. */
  librariesOf(userId: string): Promise<Map<string, Set<string>>> {
    return this.deps.cache.wrap(libraryKey(userId), LIBRARY_TTL_MS, () => this.deps.library.librariesOf(userId));
  }

  async profileLibrary(user: AuthUser, profileId: string): Promise<ProfileLibraryDto> {
    await this.requireProfile(user.id, profileId);
    return { profileId, sourceIds: [...((await this.librariesOf(user.id)).get(profileId) ?? [])] };
  }

  async setProfileLibrary(user: AuthUser, profileId: string, input: { sourceIds: string[]; pin?: string | undefined }): Promise<ProfileLibraryDto> {
    const profile = await this.requireProfile(user.id, profileId);
    const sourceIds = await this.ownedIds(user.id, input.sourceIds);
    await this.requirePinFor(user, [profile], input.pin);
    await this.deps.library.setProfileSources(profile.id, sourceIds);
    await this.changed(user.id, [profile.id]);
    return { profileId, sourceIds };
  }

  async sourceProfiles(user: AuthUser, sourceId: string): Promise<SourceProfilesDto> {
    await this.ownedIds(user.id, [sourceId]);
    const libraries = await this.librariesOf(user.id);
    return { sourceId, profileIds: [...libraries].filter(([, sources]) => sources.has(sourceId)).map(([profileId]) => profileId) };
  }

  async setSourceProfiles(user: AuthUser, sourceId: string, input: { profileIds: string[]; pin?: string | undefined }): Promise<SourceProfilesDto> {
    await this.ownedIds(user.id, [sourceId]);
    const profiles = await this.deps.profiles.records(user.id);
    const wanted = [...new Set(input.profileIds)];
    const unknown = wanted.filter((id) => !profiles.some((profile) => profile.id === id));
    if (unknown.length > 0) throw AppError.validation('Unknown profile.', { profileIds: unknown });
    // The PIN guards kids profiles whose access changes (added to or taken from).
    const before = (await this.sourceProfiles(user, sourceId)).profileIds;
    const touched = profiles.filter((profile) => wanted.includes(profile.id) !== before.includes(profile.id));
    await this.requirePinFor(user, touched, input.pin);
    await this.deps.library.setSourceProfiles(sourceId, wanted);
    await this.changed(user.id, profiles.map((profile) => profile.id));
    return { sourceId, profileIds: wanted };
  }

  /** A source was just added from `viewer`'s profile. */
  async assignNewSource(viewer: Viewer, sourceId: string, audience: NewSourceAudience): Promise<void> {
    const profiles = await this.deps.profiles.records(viewer.userId);
    const targets = audience === 'all' ? profiles.filter((profile) => profile.kind === 'standard' || profile.id === viewer.profileId) : profiles.filter((profile) => profile.id === viewer.profileId);
    await this.deps.library.setSourceProfiles(sourceId, targets.map((profile) => profile.id));
    await this.changed(viewer.userId, targets.map((profile) => profile.id));
  }

  /** A profile was just created: grown-up profiles start with every source of the account. */
  async seedProfile(userId: string, profile: Pick<ProfileRecord, 'id' | 'kind'>): Promise<void> {
    if (profile.kind === 'standard') await this.deps.library.addToProfile(profile.id, (await this.deps.sources.listByOwner(userId)).map((source) => source.id));
    await this.changed(userId, [profile.id]);
  }

  /** After anything that changes who sees what (also guest merges and source removal). */
  async changed(userId: string, profileIds: readonly string[]): Promise<void> {
    this.deps.cache.delete(libraryKey(userId));
    for (const profileId of profileIds) invalidateHome(this.deps.cache, profileId);
  }

  private async requireProfile(userId: string, profileId: string): Promise<ProfileRecord> {
    const profile = (await this.deps.profiles.records(userId)).find((item) => item.id === profileId);
    if (!profile) throw AppError.notFound('Profile');
    return profile;
  }

  private async ownedIds(userId: string, ids: readonly string[]): Promise<string[]> {
    const owned = new Set((await this.deps.sources.listByOwner(userId)).map((source) => source.id));
    const wanted = [...new Set(ids)];
    if (wanted.some((id) => !owned.has(id))) throw AppError.notFound('Source');
    return wanted;
  }

  private async requirePinFor(user: AuthUser, profiles: readonly ProfileRecord[], pin: string | undefined): Promise<void> {
    if (!this.guard) return;
    if (profiles.some((profile) => profile.kind === 'kids') || (await this.guard.kidsLocked(user))) await this.guard.requirePin(user, pin, "change what a kids profile can watch");
  }
}

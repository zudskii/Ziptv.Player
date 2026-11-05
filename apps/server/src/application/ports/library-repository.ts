/**
 * Which of the account's sources each profile sees (`profile_sources`). Callers check ownership:
 * every id passed in belongs to the same account.
 */
export interface LibraryRepository {
  /** Profile id → its sources, for every profile of the account (profiles without any are absent). */
  librariesOf(userId: string): Promise<Map<string, Set<string>>>;
  /** Replaces the profile's sources. */
  setProfileSources(profileId: string, sourceIds: readonly string[]): Promise<void>;
  /** Replaces the profiles that see the source. */
  setSourceProfiles(sourceId: string, profileIds: readonly string[]): Promise<void>;
  /** Adds the sources to the profile (a new profile's starting library); existing rows are kept. */
  addToProfile(profileId: string, sourceIds: readonly string[]): Promise<void>;
}

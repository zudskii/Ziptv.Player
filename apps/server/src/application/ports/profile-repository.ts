import type { ProfileKind } from '../../domain/viewer/profile.js';
import type { StoredProfileSettings } from '../../domain/viewer/settings.js';

export interface ProfileRecord {
  id: string;
  userId: string;
  name: string;
  color: string;
  kind: ProfileKind;
  isDefault: boolean;
  /** Opening the profile needs the account's parental PIN. */
  pinProtected: boolean;
  /** Raw stored document; read through `resolveSettings`. */
  settings: StoredProfileSettings;
  createdAt: Date;
}

export interface ProfileRepository {
  newId(): string;
  isValidId(id: string): boolean;
  /** Oldest first; the default profile is created on first use (see `ensureDefault`). */
  listByUser(userId: string): Promise<ProfileRecord[]>;
  /** Creates the default profile unless one exists (idempotent, safe under concurrency). */
  ensureDefault(userId: string, input: { id: string; name: string; color: string }): Promise<void>;
  /** Null when the account already has `max` profiles (checked under a lock). */
  create(input: { id: string; userId: string; name: string; color: string; kind: ProfileKind }, max: number): Promise<ProfileRecord | null>;
  update(id: string, userId: string, patch: { name?: string; color?: string; kind?: ProfileKind; pinProtected?: boolean }): Promise<ProfileRecord | null>;
  /** PIN removed: no profile of the account stays protected. */
  clearPinProtection(userId: string): Promise<void>;
  /**
   * Read-modify-write of a profile's settings under a row lock: two quick changes from the same
   * person (or two devices) never overwrite each other. `change` gets the stored settings and returns
   * the new ones, or throws to abort without writing. Null when there is no such profile.
   */
  changeSettings(id: string, userId: string, change: (current: StoredProfileSettings) => StoredProfileSettings): Promise<StoredProfileSettings | null>;
  /** Never deletes the default profile. */
  delete(id: string, userId: string): Promise<boolean>;
}

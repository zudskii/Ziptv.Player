export interface UserRecord {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
}

/** Persistence port for anonymous users (device identities). */
export interface UserRepository {
  create(tokenHash: string): Promise<UserRecord>;
  findByTokenHash(tokenHash: string): Promise<UserRecord | null>;
  /** One-time exchange of a pre-2.0 secret id for a new token. Returns null if unknown/used. */
  claimLegacy(legacySecretId: string, tokenHash: string): Promise<UserRecord | null>;
  touch(id: string, at: Date): Promise<void>;
}

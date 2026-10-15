import type { UserRole } from '../../domain/identity/credentials.js';

export interface UserRecord {
  id: string;
  /** null = guest. Stored normalised (see `normalizeEmail`). */
  email: string | null;
  role: UserRole;
  createdAt: Date;
  lastSeenAt: Date;
}

/** Only the login path ever reads the hash. */
export interface UserWithPassword extends UserRecord {
  passwordHash: string | null;
}

/** Persistence port for users: guests (device identities) and accounts (email + password). */
export interface UserRepository {
  createGuest(): Promise<UserRecord>;
  /** `null` when the email is already registered. */
  createAccount(input: { email: string; passwordHash: string }): Promise<UserRecord | null>;
  /** Turns a guest into an account in place (same id, so its data stays). `null` when the email is taken or the user is no guest. */
  promoteGuest(userId: string, input: { email: string; passwordHash: string }): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserWithPassword | null>;
  setPassword(userId: string, passwordHash: string): Promise<void>;
  /** One-time exchange of a pre-2.0 secret id for its user. Returns null if unknown/used. */
  claimLegacy(legacySecretId: string): Promise<UserRecord | null>;
  /** Deletes the user and, through cascades, everything it owns. */
  delete(userId: string): Promise<boolean>;
}

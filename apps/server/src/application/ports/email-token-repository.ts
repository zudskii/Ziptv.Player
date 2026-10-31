export type EmailTokenPurpose = 'verify_email' | 'reset_password';

export interface EmailTokenRecord {
  id: string;
  userId: string;
  purpose: EmailTokenPurpose;
  /** The address the link was sent to; a token is void if the account's address is no longer this one. */
  email: string;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface NewEmailToken {
  id: string;
  userId: string;
  purpose: EmailTokenPurpose;
  tokenHash: string;
  email: string;
  expiresAt: Date;
  createdAt: Date;
}

/** Single-use, expiring tokens carried by links in emails. Only their hashes are stored. */
export interface EmailTokenRepository {
  create(token: NewEmailToken): Promise<void>;
  findByHash(tokenHash: string): Promise<EmailTokenRecord | null>;
  /** Marks the token used, atomically: of any number of concurrent callers exactly one gets `true`. False if used or expired. */
  consume(id: string, now: Date): Promise<boolean>;
  /** Forgets the user's unused tokens of this kind (a new link replaces the old one). */
  invalidateForUser(userId: string, purpose: EmailTokenPurpose): Promise<void>;
  purgeExpired(now: Date): Promise<number>;
}

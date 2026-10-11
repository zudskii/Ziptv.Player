/**
 * Encryption at rest for secrets stored in the database (provider credentials, stream URLs
 * with embedded tokens, guide URLs). Each purpose uses its own derived key.
 */
export type CipherPurpose = 'source-credential' | 'stream-locator' | 'guide-url';

export interface SecretCipher {
  encrypt(purpose: CipherPurpose, plaintext: string): string;
  decrypt(purpose: CipherPurpose, ciphertext: string): string;
  /** True when the value was encrypted with a key other than the current one. */
  needsRotation(ciphertext: string): boolean;
}

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

import type { CipherPurpose, SecretCipher } from '../../application/ports/cipher.js';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface KeyEntry {
  id: string;
  master: Buffer;
  derived: Map<CipherPurpose, Buffer>;
}

/**
 * AES-256-GCM encryption at rest with key rotation.
 *
 * Format: `v1.<keyId>.<iv>.<ciphertext+tag>` (base64url). Each purpose gets its own subkey via
 * HKDF, so a stream URL can never be decrypted as a credential. Old keys stay readable (pass
 * them as previous keys) and `needsRotation` tells a migration what to re-encrypt.
 */
export class AesSecretCipher implements SecretCipher {
  private readonly current: KeyEntry;
  private readonly keys = new Map<string, KeyEntry>();

  constructor(currentKey: Buffer, previousKeys: Buffer[] = []) {
    this.current = this.register(currentKey);
    for (const key of previousKeys) this.register(key);
  }

  encrypt(purpose: CipherPurpose, plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.subkey(this.current, purpose), iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return `${VERSION}.${this.current.id}.${iv.toString('base64url')}.${body.toString('base64url')}`;
  }

  decrypt(purpose: CipherPurpose, ciphertext: string): string {
    const [version, keyId, ivPart, bodyPart] = ciphertext.split('.');
    if (version !== VERSION || !keyId || !ivPart || !bodyPart) throw new Error('Unrecognised ciphertext format');
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`Unknown encryption key ${keyId} (was DATA_ENCRYPTION_KEY rotated without keeping the old key?)`);
    const iv = Buffer.from(ivPart, 'base64url');
    const body = Buffer.from(bodyPart, 'base64url');
    if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw new Error('Corrupt ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.subkey(key, purpose), iv);
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString('utf8');
  }

  needsRotation(ciphertext: string): boolean {
    return ciphertext.split('.')[1] !== this.current.id;
  }

  private register(master: Buffer): KeyEntry {
    const id = createHash('sha256').update(master).digest('hex').slice(0, 8);
    const entry = this.keys.get(id) ?? { id, master, derived: new Map() };
    this.keys.set(id, entry);
    return entry;
  }

  private subkey(entry: KeyEntry, purpose: CipherPurpose): Buffer {
    let key = entry.derived.get(purpose);
    if (!key) {
      key = Buffer.from(hkdfSync('sha256', entry.master, Buffer.alloc(0), `ziptv:${purpose}`, 32));
      entry.derived.set(purpose, key);
    }
    return key;
  }
}

/**
 * Accepts a 32-byte base64 key or any passphrase of ≥ 32 characters (stretched with SHA-256,
 * then HKDF per purpose). Passphrases are convenient in `.env`; random keys are better.
 */
export function parseEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  const decoded = /^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(trimmed) ? Buffer.from(trimmed, 'base64') : null;
  if (decoded && decoded.length === 32) return decoded;
  return createHash('sha256').update(trimmed, 'utf8').digest();
}

import { createPublicKey, verify, type KeyObject } from 'node:crypto';

import type { FeedSignatures } from '../../application/ports/feed-signatures.js';

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; followed by the 32 raw key bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Ed25519 (RFC 8032) through node:crypto. Keys come as base64 of the 32 raw bytes (what most
 * libraries print) or as a PEM "PUBLIC KEY" block; anything else — including RSA/EC keys — is refused.
 */
export class Ed25519FeedSignatures implements FeedSignatures {
  private readonly cache = new Map<string, KeyObject | null>();

  isPublicKey(key: string): boolean {
    return this.keyObject(key) !== null;
  }

  verify(body: Uint8Array, signature: string, key: string): boolean {
    const publicKey = this.keyObject(key);
    if (!publicKey) return false;
    const bytes = Buffer.from(signature, 'base64');
    if (bytes.length !== 64) return false;
    try {
      return verify(null, body, publicKey, bytes);
    } catch {
      return false;
    }
  }

  private keyObject(key: string): KeyObject | null {
    const trimmed = key.trim();
    if (this.cache.has(trimmed)) return this.cache.get(trimmed)!;
    let parsed: KeyObject | null = null;
    try {
      if (trimmed.startsWith('-----BEGIN')) {
        parsed = createPublicKey(trimmed);
      } else {
        const raw = Buffer.from(trimmed, 'base64');
        if (raw.length === 32) parsed = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
      }
      if (parsed && parsed.asymmetricKeyType !== 'ed25519') parsed = null;
    } catch {
      parsed = null;
    }
    if (this.cache.size > 100) this.cache.clear();
    this.cache.set(trimmed, parsed);
    return parsed;
  }
}

import { describe, expect, it } from 'vitest';

import { MediaTokenCodec } from './media-token.js';
import { AesSecretCipher, parseEncryptionKey } from './secret-cipher.js';

describe('AesSecretCipher', () => {
  const key = parseEncryptionKey('a'.repeat(40));
  const cipher = new AesSecretCipher(key);

  it('round-trips with random IVs and authenticates the ciphertext', () => {
    const a = cipher.encrypt('stream-locator', 'http://h/u/p/1.ts');
    const b = cipher.encrypt('stream-locator', 'http://h/u/p/1.ts');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.[a-f0-9]{8}\.[\w-]+\.[\w-]+$/);
    expect(cipher.decrypt('stream-locator', a)).toBe('http://h/u/p/1.ts');
    // Flip a character that carries full bits (not the last one) to a guaranteed different value.
    const tampered = `${a.slice(0, -2)}${a.at(-2) === 'A' ? 'B' : 'A'}${a.slice(-1)}`;
    expect(() => cipher.decrypt('stream-locator', tampered)).toThrow();
  });

  it('separates purposes (a stream URL never decrypts as a credential)', () => {
    const sealed = cipher.encrypt('stream-locator', 'secret');
    expect(() => cipher.decrypt('source-credential', sealed)).toThrow();
  });

  it('supports key rotation: old ciphertexts stay readable and are flagged for re-encryption', () => {
    const oldKey = parseEncryptionKey('old-key-'.repeat(5));
    const sealedWithOld = new AesSecretCipher(oldKey).encrypt('source-credential', '{"x":1}');
    const rotated = new AesSecretCipher(key, [oldKey]);
    expect(rotated.decrypt('source-credential', sealedWithOld)).toBe('{"x":1}');
    expect(rotated.needsRotation(sealedWithOld)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt('source-credential', 'y'))).toBe(false);
    expect(() => cipher.decrypt('source-credential', sealedWithOld)).toThrow(/Unknown encryption key/);
  });

  it('accepts base64 keys and passphrases', () => {
    expect(parseEncryptionKey(Buffer.alloc(32, 7).toString('base64'))).toEqual(Buffer.alloc(32, 7));
    expect(parseEncryptionKey('a passphrase that is long enough to use')).toHaveLength(32);
  });
});

describe('MediaTokenCodec image tokens', () => {
  it('are stable within a bucket (CDN-cacheable) and only valid on the image endpoint', () => {
    let now = 1_000_000_000;
    const codec = new MediaTokenCodec(Buffer.from('x'.repeat(32)), 3600, () => now);
    const first = codec.issueImage('http://h/logo.png');
    now += 3600;
    expect(codec.issueImage('http://h/logo.png')).toBe(first);
    expect(codec.verify(first, 'image')?.url).toBe('http://h/logo.png');
    expect(codec.verify(first, 'stream')).toBeNull();
    expect(codec.verify(codec.issue('http://h/a.m3u8', undefined, now + 60, { kind: 'session', id: 's' }), 'image')).toBeNull();
    expect(codec.issueImage('http://h/other.png')).not.toBe(first);
  });
});

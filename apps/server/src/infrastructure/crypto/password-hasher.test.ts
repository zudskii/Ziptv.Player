import { describe, expect, it } from 'vitest';

import { ScryptPasswordHasher } from './password-hasher.js';

const cheap = { N: 2 ** 10, r: 8, p: 1 };

describe('ScryptPasswordHasher', () => {
  const hasher = new ScryptPasswordHasher(cheap);

  it('verifies the right password and rejects others', async () => {
    const stored = await hasher.hash('correct horse');
    expect(await hasher.verify('correct horse', stored)).toBe(true);
    expect(await hasher.verify('correct horsf', stored)).toBe(false);
    expect(await hasher.verify('', stored)).toBe(false);
  });

  it('salts every hash and stores its parameters', async () => {
    const [a, b] = await Promise.all([hasher.hash('same'), hasher.hash('same')]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(a).not.toContain('same');
  });

  it('treats visually identical Unicode passwords as equal (NFKC)', async () => {
    const stored = await hasher.hash('ｐａｓｓｗｏｒｄ１'); // full-width forms
    expect(await hasher.verify('password1', stored)).toBe(true);
  });

  it('answers false (after real work) for an unknown account', async () => {
    expect(await hasher.verify('anything', null)).toBe(false);
  });

  it('rejects malformed or tampered hashes instead of throwing or allocating gigabytes', async () => {
    expect(await hasher.verify('x', 'not-a-hash')).toBe(false);
    expect(await hasher.verify('x', 'scrypt$1024$8$1$c2FsdA')).toBe(false);
    expect(await hasher.verify('x', 'scrypt$1073741824$8$1$c2FsdA$aGFzaA')).toBe(false);
    expect(await hasher.verify('x', 'scrypt$1000$8$1$c2FsdA$aGFzaA')).toBe(false); // not a power of two
    expect(await hasher.verify('x', 'bcrypt$1024$8$1$c2FsdA$aGFzaA')).toBe(false);
  });

  it('asks for a rehash when the stored parameters are weaker than the current ones', async () => {
    const old = await hasher.hash('pw');
    const stronger = new ScryptPasswordHasher({ N: 2 ** 11, r: 8, p: 1 });
    expect(hasher.needsRehash(old)).toBe(false);
    expect(stronger.needsRehash(old)).toBe(true);
    expect(stronger.needsRehash('garbage')).toBe(true);
    // ... while an old hash still verifies under the new settings, so nobody gets locked out.
    expect(await stronger.verify('pw', old)).toBe(true);
  });

  it('limits concurrent hashing but completes every request', async () => {
    const limited = new ScryptPasswordHasher(cheap, 1);
    const stored = await Promise.all(Array.from({ length: 6 }, (_, i) => limited.hash(`pw-${i}`)));
    const checks = await Promise.all(stored.map((hash, i) => limited.verify(`pw-${i}`, hash)));
    expect(checks.every(Boolean)).toBe(true);
  });
});

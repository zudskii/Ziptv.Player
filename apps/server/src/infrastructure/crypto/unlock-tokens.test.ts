import { describe, expect, it } from 'vitest';

import { HmacUnlockTokens } from './unlock-tokens.js';

const claims = { userId: 'u1', sessionId: 's1', profileId: 'p1', pinVersion: 3, expiresAt: 1_000 };

describe('parental unlock tokens', () => {
  const tokens = new HmacUnlockTokens(Buffer.alloc(32, 7));

  it('round-trips until expiry', () => {
    const token = tokens.issue(claims);
    expect(tokens.verify(token, 999)).toEqual(claims);
    expect(tokens.verify(token, 1_000)).toBeNull();
  });

  it('refuses tampered, foreign-key and malformed tokens', () => {
    const token = tokens.issue(claims);
    const [prefix, body, mac] = [token.slice(0, 4), ...token.slice(4).split('.')] as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ u: 'u1', s: 's1', p: 'p2', v: 3, e: 1_000 })).toString('base64url');
    expect(tokens.verify(`${prefix}${forged}.${mac}`, 0)).toBeNull();
    expect(tokens.verify(`${prefix}${body}.${mac.slice(1)}x`, 0)).toBeNull();
    expect(new HmacUnlockTokens(Buffer.alloc(32, 8)).verify(token, 0)).toBeNull();
    for (const junk of ['', 'pu1.', 'pu1.a.b', 'x'.repeat(600), token.replace('pu1.', 'pu2.')]) expect(tokens.verify(junk, 0)).toBeNull();
  });
});

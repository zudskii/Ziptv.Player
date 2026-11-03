import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import type { UnlockClaims, UnlockTokens } from '../../application/ports/unlock-tokens.js';

const PREFIX = 'pu1.';
const MAX_LENGTH = 512;

/**
 * Parental unlock tokens: `pu1.<base64url(json)>.<base64url(HMAC-SHA256)>`. Stateless (any
 * instance verifies), short-lived, bound to the account, the device session, the profile and
 * the PIN version — a token copied to another device, profile or after a PIN change is worthless.
 * The claims are not secret (ids only); the MAC makes them unforgeable.
 */
export class HmacUnlockTokens implements UnlockTokens {
  private readonly key: Buffer;

  constructor(secret: Buffer) {
    this.key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'ziptv:parental-unlock:v1', 32));
  }

  issue(claims: UnlockClaims): string {
    const body = Buffer.from(JSON.stringify({ u: claims.userId, s: claims.sessionId, p: claims.profileId, v: claims.pinVersion, e: claims.expiresAt })).toString('base64url');
    return `${PREFIX}${body}.${this.mac(body)}`;
  }

  verify(token: string, nowSeconds: number): UnlockClaims | null {
    if (token.length > MAX_LENGTH || !token.startsWith(PREFIX)) return null;
    const [body, mac] = token.slice(PREFIX.length).split('.');
    if (!body || !mac) return null;
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const c = raw as Record<string, unknown>;
    if (typeof c.u !== 'string' || typeof c.s !== 'string' || typeof c.p !== 'string' || typeof c.v !== 'number' || typeof c.e !== 'number') return null;
    if (c.e <= nowSeconds) return null;
    return { userId: c.u, sessionId: c.s, profileId: c.p, pinVersion: c.v, expiresAt: c.e };
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}

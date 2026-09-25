import { createHmac, timingSafeEqual } from 'node:crypto';

import type { StreamHeaders } from '../m3u/index.js';

export interface StreamTokenPayload {
  /** Upstream URL. */
  u: string;
  /** Upstream request headers (whitelisted). */
  h?: StreamHeaders;
  /** Expiry, unix seconds. */
  e: number;
}

const SIGNATURE_LENGTH = 32; // base64url chars ≈ 192 bits of the HMAC-SHA256

/**
 * Self-contained, HMAC-signed proxy tokens: `base64url(json).signature`.
 *
 * Why: the proxy must only fetch URLs the server itself handed out (channel URLs and the
 * segment/key URLs found inside their manifests). Signing makes it impossible to use the
 * proxy as an open relay, while staying stateless — any instance can verify any token, so
 * the proxy scales horizontally without a shared store.
 */
export class StreamTokenCodec {
  constructor(
    private readonly secret: Buffer,
    private readonly ttlSeconds: number,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Expiry for a freshly issued top-level token. */
  newExpiry(): number {
    return this.nowSeconds() + this.ttlSeconds;
  }

  issue(url: string, headers: StreamHeaders | undefined, expiresAt: number): string {
    const payload: StreamTokenPayload = { u: url, e: expiresAt };
    if (headers && Object.keys(headers).length > 0) payload.h = headers;
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  verify(token: string): StreamTokenPayload | null {
    const dot = token.lastIndexOf('.');
    if (dot <= 0 || token.length - dot - 1 !== SIGNATURE_LENGTH) return null;
    const body = token.slice(0, dot);
    const expected = Buffer.from(this.sign(body));
    const actual = Buffer.from(token.slice(dot + 1));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!isPayload(payload) || payload.e < this.nowSeconds()) return null;
    return payload;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url').slice(0, SIGNATURE_LENGTH);
  }
}

function isPayload(value: unknown): value is StreamTokenPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.u === 'string' &&
    typeof candidate.e === 'number' &&
    (candidate.h === undefined || (typeof candidate.h === 'object' && candidate.h !== null))
  );
}

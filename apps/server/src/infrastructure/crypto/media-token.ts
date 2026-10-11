import { createHmac, timingSafeEqual } from 'node:crypto';

import type { StreamHeaders } from '../../domain/catalog/model.js';

export type MediaTokenPurpose = 'stream' | 'image';

export interface MediaTokenPayload {
  /** Upstream URL. */
  u: string;
  /** Upstream request headers (whitelisted). */
  h?: StreamHeaders;
  /** Expiry, unix seconds. */
  e: number;
  /** Purpose: absent/'s' = stream, 'i' = image. A token only works for its own endpoint. */
  p?: 's' | 'i';
}

const SIGNATURE_LENGTH = 32; // base64url chars ≈ 192 bits of the HMAC-SHA256
const IMAGE_BUCKET_SECONDS = 30 * 86_400;

/**
 * Self-contained, HMAC-signed media tokens: `base64url(json).signature`.
 *
 * The proxies must only fetch URLs the server itself handed out (stream URLs, the segment/key
 * URLs inside their manifests, guide icons). Signing makes it impossible to use them as an
 * open relay while staying stateless — any instance verifies any token, so the proxy scales
 * horizontally without a shared store.
 */
export class MediaTokenCodec {
  constructor(
    private readonly secret: Buffer,
    private readonly ttlSeconds: number,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Expiry for a freshly issued top-level stream token. */
  newExpiry(): number {
    return this.nowSeconds() + this.ttlSeconds;
  }

  issue(url: string, headers: StreamHeaders | undefined, expiresAt: number): string {
    const payload: MediaTokenPayload = { u: url, e: expiresAt };
    if (headers && Object.keys(headers).length > 0) payload.h = headers;
    return this.encode(payload);
  }

  /**
   * Image tokens expire at the end of a fixed 30-day bucket (+ one bucket of grace), so the same
   * URL yields the same token for weeks and a CDN can cache the proxied image.
   */
  issueImage(url: string): string {
    const bucketEnd = (Math.floor(this.nowSeconds() / IMAGE_BUCKET_SECONDS) + 2) * IMAGE_BUCKET_SECONDS;
    return this.encode({ u: url, e: bucketEnd, p: 'i' });
  }

  verify(token: string, purpose: MediaTokenPurpose = 'stream'): MediaTokenPayload | null {
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
    const tokenPurpose: MediaTokenPurpose = payload.p === 'i' ? 'image' : 'stream';
    return tokenPurpose === purpose ? payload : null;
  }

  private encode(payload: MediaTokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url').slice(0, SIGNATURE_LENGTH);
  }
}

function isPayload(value: unknown): value is MediaTokenPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.u === 'string' &&
    typeof candidate.e === 'number' &&
    (candidate.h === undefined || (typeof candidate.h === 'object' && candidate.h !== null)) &&
    (candidate.p === undefined || candidate.p === 's' || candidate.p === 'i')
  );
}

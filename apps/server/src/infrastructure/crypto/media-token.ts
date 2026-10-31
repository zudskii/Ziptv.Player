import { createCipheriv, createDecipheriv, createHmac, hkdfSync } from 'node:crypto';

import type { MediaGrant } from '../../application/ports/media-urls.js';
import type { StreamHeaders } from '../../domain/catalog/model.js';

export type MediaTokenPurpose = 'stream' | 'image';

/** A verified token, as the proxies use it. Never serialised back to a client. */
export interface MediaToken {
  url: string;
  headers: StreamHeaders | undefined;
  /** Unix seconds. */
  expiresAt: number;
  purpose: MediaTokenPurpose;
  /** Stream tokens only: what keeps this link alive (a signed-in device, an export link). */
  grant: MediaGrant | null;
}

/** Wire payload (inside the ciphertext): short keys keep segment URLs small. */
interface Payload {
  u: string;
  h?: StreamHeaders;
  e: number;
  p: 's' | 'i';
  g?: { k: 's' | 'x'; i: string };
}

const VERSION = '2';
const SALT_BYTES = 16;
const TAG_BYTES = 16;
/** Each token has its own key (HKDF over a fresh salt), so a fixed IV is safe and nonce reuse cannot happen. */
const IV = Buffer.alloc(12, 0);
const IMAGE_BUCKET_SECONDS = 30 * 86_400;
const MAX_TOKEN_LENGTH = 16_384;

/**
 * Media tokens: `2<base64url(salt | AES-256-GCM(json) | tag)>`, key = HKDF(secret, salt).
 *
 * The proxies must only fetch URLs the server handed out (stream URLs, the segment/key URLs of
 * their manifests, artwork). The token carries that URL — and for some providers credentials in
 * its path/query and request headers — so it is *encrypted*, not just signed: a viewer holding a
 * proxy link learns nothing about the provider behind it. GCM's tag still makes tampering or
 * forging impossible, and any instance with the secret can verify it (stateless, scales
 * horizontally). Revocation is not encoded here: stream tokens name a grant that the proxy
 * re-checks (see `MediaGrantChecker`).
 *
 * Every token is encrypted under its own key, derived from a synthetic salt (HMAC of the
 * plaintext, SIV-style): no nonce is ever reused with a different plaintext, however many segment
 * links are issued, and the same input always yields the same token. That stability matters:
 * players identify init sections and keys by URL across playlist refreshes (a changing URL makes
 * hls.js re-initialise), and a CDN can cache artwork. Equal tokens ⇔ equal plaintexts is all it
 * reveals.
 */
export class MediaTokenCodec {
  private readonly master: Buffer;
  private readonly saltKey: Buffer;

  constructor(
    secret: Buffer,
    private readonly ttlSeconds: number,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.master = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'ziptv:media-token:v2:master', 32));
    this.saltKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'ziptv:media-token:v2:salt', 32));
  }

  /** Expiry for a freshly issued top-level stream token. */
  newExpiry(ttlSeconds = this.ttlSeconds): number {
    return this.nowSeconds() + ttlSeconds;
  }

  now(): number {
    return this.nowSeconds();
  }

  issue(url: string, headers: StreamHeaders | undefined, expiresAt: number, grant: MediaGrant): string {
    const payload: Payload = { u: url, e: expiresAt, p: 's', g: { k: grant.kind === 'session' ? 's' : 'x', i: grant.id } };
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

  verify(token: string, purpose: MediaTokenPurpose): MediaToken | null {
    if (token.length > MAX_TOKEN_LENGTH || token[0] !== VERSION) return null;
    const raw = Buffer.from(token.slice(1), 'base64url');
    if (raw.length < SALT_BYTES + TAG_BYTES + 2) return null;

    let payload: unknown;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.tokenKey(raw.subarray(0, SALT_BYTES)), IV);
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      const plain = Buffer.concat([decipher.update(raw.subarray(SALT_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
      payload = JSON.parse(plain.toString('utf8'));
    } catch {
      return null; // wrong key, tampered, truncated or not ours
    }
    if (!isPayload(payload) || payload.e < this.nowSeconds()) return null;
    const tokenPurpose: MediaTokenPurpose = payload.p === 'i' ? 'image' : 'stream';
    if (tokenPurpose !== purpose) return null;
    // A stream link that is not tied to anything revocable is never accepted.
    if (tokenPurpose === 'stream' && !payload.g) return null;
    return {
      url: payload.u,
      headers: payload.h,
      expiresAt: payload.e,
      purpose: tokenPurpose,
      grant: payload.g ? { kind: payload.g.k === 's' ? 'session' : 'export', id: payload.g.i } : null,
    };
  }

  private encode(payload: Payload): string {
    const json = JSON.stringify(payload);
    const salt = createHmac('sha256', this.saltKey).update(json).digest().subarray(0, SALT_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.tokenKey(salt), IV);
    const body = Buffer.concat([cipher.update(json, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    const token = VERSION + Buffer.concat([salt, body]).toString('base64url');
    // Would be refused by verify(): fail loudly here instead of handing out a dead link.
    if (token.length > MAX_TOKEN_LENGTH) throw new Error(`Media token too long (${token.length} chars): stream address or headers exceed the proxy limit`);
    return token;
  }

  private tokenKey(salt: Buffer): Buffer {
    return Buffer.from(hkdfSync('sha256', this.master, salt, 'ziptv:media-token:v2:key', 32));
  }
}

function isPayload(value: unknown): value is Payload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const grant = candidate.g as Record<string, unknown> | undefined;
  return (
    typeof candidate.u === 'string' &&
    typeof candidate.e === 'number' &&
    (candidate.p === 's' || candidate.p === 'i') &&
    (candidate.h === undefined || (typeof candidate.h === 'object' && candidate.h !== null)) &&
    (grant === undefined || (typeof grant === 'object' && grant !== null && (grant.k === 's' || grant.k === 'x') && typeof grant.i === 'string'))
  );
}

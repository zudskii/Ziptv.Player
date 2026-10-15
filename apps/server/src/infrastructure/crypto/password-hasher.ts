import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

import type { PasswordHasher } from '../../application/ports/password-hasher.js';

export interface ScryptParams {
  /** CPU/memory cost, a power of two. Memory use is 128 · N · r bytes. */
  N: number;
  r: number;
  p: number;
}

/** OWASP password-storage guidance: N=2^16, r=8, p=2 (64 MiB, a few hundred ms). */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 16, r: 8, p: 2 };

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';

/**
 * scrypt from Node's standard library (no native dependency to build in Docker).
 * Stored form: `scrypt$N$r$p$<salt>$<hash>` (base64url), so parameters can change later and old
 * hashes keep verifying (and are upgraded on the next login, see `needsRehash`).
 *
 * scrypt runs on libuv's small thread pool, which DNS lookups for upstream streams share, so
 * at most `maxConcurrent` hashes run at once; the rest wait in line.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private dummy: Promise<string> | null = null;

  constructor(
    private readonly params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
    private readonly maxConcurrent = 2,
  ) {}

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const key = await this.derive(password, salt, this.params);
    return [PREFIX, this.params.N, this.params.r, this.params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
  }

  async verify(password: string, stored: string | null): Promise<boolean> {
    if (stored === null) {
      // Unknown account: spend the same time on a throw-away hash.
      this.dummy ??= this.hash('ziptv-timing-equaliser');
      await this.verify(password, await this.dummy);
      return false;
    }
    const parsed = parse(stored);
    if (!parsed) return false;
    const key = await this.derive(password, parsed.salt, parsed.params);
    return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
  }

  needsRehash(stored: string): boolean {
    const parsed = parse(stored);
    if (!parsed) return true;
    const { N, r, p } = parsed.params;
    return N < this.params.N || r < this.params.r || p < this.params.p;
  }

  private async derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
    await this.acquire();
    try {
      const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 };
      return await new Promise<Buffer>((resolve, reject) => {
        // NFKC so the same visible password typed on different devices hashes identically.
        scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key)));
      });
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); // hand the slot over directly
    else this.running--;
  }
}

function parse(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const [prefix, n, r, p, salt, hash, ...rest] = stored.split('$');
  if (prefix !== PREFIX || !n || !r || !p || !salt || !hash || rest.length > 0) return null;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  // Refuse absurd parameters from a tampered row instead of allocating gigabytes.
  const valid =
    Number.isInteger(params.N) && params.N >= 2 ** 10 && params.N <= 2 ** 20 && (params.N & (params.N - 1)) === 0 &&
    Number.isInteger(params.r) && params.r >= 1 && params.r <= 16 &&
    Number.isInteger(params.p) && params.p >= 1 && params.p <= 16;
  if (!valid) return null;
  return { params, salt: Buffer.from(salt, 'base64url'), hash: Buffer.from(hash, 'base64url') };
}

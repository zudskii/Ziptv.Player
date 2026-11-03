import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import type { TelemetrySubject, TelemetryTokens } from '../../application/ports/health.js';
import { isEntityId } from '../../domain/shared/ids.js';

const TYPES = { f: 'feed', s: 'source' } as const;

/**
 * `<type><id-hex>.<expires>.<mac>` — HMAC-signed, so telemetry cannot be attributed to an
 * arbitrary feed. It is not secret (a feed id reveals nothing about the upstream).
 */
export class HmacTelemetryTokens implements TelemetryTokens {
  private readonly key: Buffer;

  constructor(secret: Buffer) {
    this.key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'ziptv:telemetry-token:v1', 32));
  }

  issue(subject: TelemetrySubject, expiresAt: Date, sessionId: string): string {
    const body = `${subject.type === 'feed' ? 'f' : 's'}${subject.id.replaceAll('-', '')}.${Math.floor(expiresAt.getTime() / 1000)}`;
    return `${body}.${this.mac(`${body}.${sessionId}`)}`;
  }

  verify(token: string, sessionId: string, now: Date): TelemetrySubject | null {
    const match = /^([fs])([0-9a-f]{32})\.(\d{1,12})\.([\w-]{22})$/.exec(token);
    if (!match) return null;
    const [, type, hex, expires, mac] = match;
    const body = `${type}${hex}.${expires}`;
    const expected = Buffer.from(this.mac(`${body}.${sessionId}`));
    if (expected.length !== mac!.length || !timingSafeEqual(expected, Buffer.from(mac!))) return null;
    if (Number(expires) * 1000 < now.getTime()) return null;
    const id = `${hex!.slice(0, 8)}-${hex!.slice(8, 12)}-${hex!.slice(12, 16)}-${hex!.slice(16, 20)}-${hex!.slice(20)}`;
    return isEntityId(id) ? { type: TYPES[type as 'f' | 's'], id } : null;
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url').slice(0, 22);
  }
}

import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Reference implementation of the vendor side of ZIPTV Vendor Feed v1 (docs/vendor-feed-v1.md),
 * for tests and for vendors to compare against: keeps a catalogue, answers `GET ?since=<cursor>`
 * with a signed full snapshot or the changes since that cursor.
 *
 * Wire items are plain JSON objects in contract shape (`channels[]`, `vod[]`, `packages[]`).
 */
export class ReferenceVendorFeed {
  readonly keyId: string;
  readonly publicKey: string;
  private readonly privateKey: KeyObject;
  private sequence = 0;
  private readonly items = new Map<string, { kind: Kind; value: Record<string, unknown>; seq: number }>();
  private readonly deletions: { kind: Kind; id: string; seq: number }[] = [];
  /** Test switches. */
  signing: 'valid' | 'none' | 'wrong-key' | 'tampered' = 'valid';
  /** Fixed `generatedAt` (to simulate a replayed old feed); null = now. */
  generatedAt: Date | null = null;
  /** Requests seen (the `since` each sync sent). */
  readonly requests: (string | null)[] = [];

  constructor(
    readonly providerSlug: string,
    keyId = 'k1',
  ) {
    const pair = generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey;
    this.keyId = keyId;
    // Raw 32-byte key, base64 — the form most vendors hand over.
    this.publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  }

  upsert(kind: Kind, value: Record<string, unknown> & { id: string }): void {
    this.items.set(`${kind}:${value.id}`, { kind, value, seq: ++this.sequence });
  }

  remove(kind: Kind, id: string): void {
    this.items.delete(`${kind}:${id}`);
    this.deletions.push({ kind, id, seq: ++this.sequence });
  }

  get cursor(): string {
    return `seq-${this.sequence}`;
  }

  /** The feed document for `since` (null/unknown = full). */
  document(since: string | null): Record<string, unknown> {
    const from = since && /^seq-\d+$/.test(since) ? Number(since.slice(4)) : null;
    const full = from === null || from > this.sequence;
    const changed = [...this.items.values()].filter((item) => full || item.seq > from!);
    const deleted = full ? [] : this.deletions.filter((entry) => entry.seq > from!);
    const of = (kind: Kind) => changed.filter((item) => item.kind === kind).map((item) => item.value);
    const gone = (kind: Kind) => deleted.filter((entry) => entry.kind === kind).map((entry) => entry.id);
    return {
      version: 1,
      provider: { id: this.providerSlug, name: 'Reference Vendor' },
      generatedAt: (this.generatedAt ?? new Date()).toISOString(),
      cursor: this.cursor,
      full,
      channels: of('channels'),
      vod: of('vod'),
      packages: of('packages'),
      ...(full ? {} : { deleted: { channels: gone('channels'), vod: gone('vod'), packages: gone('packages') } }),
    };
  }

  /** Body + signature header as the vendor would send them. */
  signed(since: string | null): { body: Buffer; signature: string | null } {
    const body = Buffer.from(JSON.stringify(this.document(since)));
    if (this.signing === 'none') return { body, signature: null };
    const key = this.signing === 'wrong-key' ? generateKeyPairSync('ed25519').privateKey : this.privateKey;
    const signature = sign(null, body, key).toString('base64');
    const sent = this.signing === 'tampered' ? Buffer.from(body.toString('utf8').replace('"full":', '"full" :')) : body;
    return { body: sent, signature: `keyId=${this.keyId}, sig=${signature}` };
  }

  /** HTTP handler for a fake origin (`startOrigin`). */
  handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://feed.local');
    const since = url.searchParams.get('since');
    this.requests.push(since);
    const { body, signature } = this.signed(since);
    res.writeHead(200, { 'content-type': 'application/json', ...(signature ? { 'x-ziptv-signature': signature } : {}) });
    res.end(body);
  }
}

type Kind = 'channels' | 'vod' | 'packages';

import {
  decodeContent,
  firstHeader,
  isContentEncoded,
  type UpstreamClient,
} from '../http/upstream-client.js';
import type { Logger } from '../../application/ports/logger.js';
import type { StreamProber } from '../../application/ports/stream-prober.js';
import type { StreamHeaders, StreamKind } from '../../domain/catalog/model.js';
import { TtlCache } from '../cache/ttl-cache.js';
import { destroyQuietly } from '../streams/destroy.js';
import { peekStream } from '../streams/peek.js';
import { sniffStreamKind } from './stream-sniffer.js';

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_BYTES = 1024;

/**
 * Detects the container of extension-less URLs (Xtream `…/user/pass/1234`, short links)
 * by reading their first bytes. Results are cached per instance so a channel is probed at
 * most once per TTL — probing opens a real upstream connection, and many IPTV panels allow
 * only a single concurrent connection per account.
 */
export class HttpStreamProber implements StreamProber {
  private readonly cache = new TtlCache<string, StreamKind>(5_000, 30 * 60 * 1000);

  constructor(
    private readonly upstream: UpstreamClient,
    private readonly logger: Logger,
  ) {}

  async probe(url: string, headers: StreamHeaders): Promise<StreamKind> {
    const cached = this.cache.get(url);
    if (cached) return cached;

    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    try {
      const response = await this.upstream.request(url, { headers, signal, bodyTimeoutMs: PROBE_TIMEOUT_MS });
      if (response.status >= 400) {
        destroyQuietly(response.body);
        return 'unknown';
      }
      const encoding = firstHeader(response.headers['content-encoding']);
      const body = isContentEncoded(encoding) ? decodeContent(response.body, encoding) : response.body;
      const { head } = await peekStream(body, PROBE_BYTES).finally(() => {
        destroyQuietly(body);
        destroyQuietly(response.body);
      });

      const kind = sniffStreamKind(head, firstHeader(response.headers['content-type']));
      if (kind !== 'unknown') this.cache.set(url, kind);
      return kind;
    } catch (error) {
      this.logger.debug({ err: error, host: safeHost(url) }, 'Stream probe failed');
      return 'unknown';
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

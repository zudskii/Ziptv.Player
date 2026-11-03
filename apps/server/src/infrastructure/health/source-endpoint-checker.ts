import type { SourceEndpointChecker } from '../../application/ports/health.js';
import type { SourceCredential } from '../../domain/sources/source.js';
import { UpstreamError, type UpstreamClient } from '../http/upstream-client.js';
import type { XtreamProvider } from '../providers/xtream-provider.js';
import { destroyQuietly } from '../streams/destroy.js';

const TIMEOUT_MS = 15_000;

/**
 * The lightest possible "is the provider there?": the first 4 KB of an M3U playlist (Range
 * request), or the Xtream account call. Never a stream — that would take one of the account's
 * few connection slots away from the viewer.
 */
export class HttpSourceEndpointChecker implements SourceEndpointChecker {
  constructor(
    private readonly upstream: UpstreamClient,
    private readonly xtream: Pick<XtreamProvider, 'verifyAccount'>,
  ) {}

  async check(credential: SourceCredential, signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number | null; message: string | null }> {
    const started = Date.now();
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
    try {
      if (credential.type === 'xtream') {
        await this.xtream.verifyAccount(credential, timeout);
        return { ok: true, latencyMs: Date.now() - started, message: null };
      }
      const response = await this.upstream.request(credential.url, { headers: { range: 'bytes=0-4095' }, signal: timeout, bodyTimeoutMs: TIMEOUT_MS });
      const latencyMs = Date.now() - started;
      destroyQuietly(response.body);
      return response.status < 400 ? { ok: true, latencyMs, message: null } : { ok: false, latencyMs: null, message: `The provider answered HTTP ${response.status}` };
    } catch (error) {
      const message = error instanceof UpstreamError ? (error.kind === 'timeout' ? 'The provider did not answer in time' : 'The provider could not be reached') : 'The provider check failed';
      return { ok: false, latencyMs: null, message };
    }
  }
}

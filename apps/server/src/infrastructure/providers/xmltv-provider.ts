import { GuideFetchError, type XmltvHandlers, type XmltvReader } from '../../application/ports/xmltv.js';
import { decodeContent, firstHeader, UpstreamError, type UpstreamClient } from '../http/upstream-client.js';
import { readXmltvStream } from '../parsers/xmltv/xmltv-reader.js';
import { destroyQuietly } from '../streams/destroy.js';

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Downloader + parser of XMLTV guides (EPG flow: XMLTV URL → Downloader → Parser → …). */
export class HttpXmltvReader implements XmltvReader {
  constructor(
    private readonly upstream: UpstreamClient,
    private readonly maxBytes: number,
  ) {}

  async read(url: string, signal: AbortSignal, handlers: XmltvHandlers): Promise<{ bytes: number }> {
    const target = new URL(url);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
    let response;
    try {
      response = await this.upstream.request(target, {
        headers: { 'accept-encoding': 'gzip, deflate, br', accept: 'application/xml, text/xml, application/gzip, */*' },
        signal: combined,
        bodyTimeoutMs: 120_000,
      });
    } catch (error) {
      throw toGuideError(error, target);
    }
    if (response.status >= 400) {
      destroyQuietly(response.body);
      const problem = response.status === 401 || response.status === 403 ? 'auth_failed' : 'unavailable';
      throw new GuideFetchError(problem, `The guide server answered HTTP ${response.status}.`);
    }
    const body = decodeContent(response.body, firstHeader(response.headers['content-encoding']));
    try {
      return await readXmltvStream(body, handlers, { maxBytes: this.maxBytes, signal: combined });
    } catch (error) {
      if (error instanceof GuideFetchError) throw error;
      throw toGuideError(error, target);
    } finally {
      destroyQuietly(body);
      destroyQuietly(response.body);
    }
  }
}

function toGuideError(error: unknown, url: URL): GuideFetchError {
  if (error instanceof GuideFetchError) return error;
  if (error instanceof UpstreamError) {
    if (error.kind === 'blocked') return new GuideFetchError('blocked', 'The guide URL points to a private network address.');
    if (error.kind === 'timeout') return new GuideFetchError('unavailable', `${url.host} did not answer in time.`);
    return new GuideFetchError('unavailable', `Could not download the guide from ${url.host}.`, { cause: error });
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new GuideFetchError('unavailable', `Downloading the guide from ${url.host} timed out.`, { cause: error });
  }
  if (error instanceof Error && /gzip|header check|unexpected end/i.test(error.message)) {
    return new GuideFetchError('invalid', 'The guide file is corrupt (bad compression).', { cause: error });
  }
  return new GuideFetchError('unavailable', `Could not read the guide from ${url.host}.`, { cause: error });
}

import { SourceFetchError, type CatalogProvider, type FetchContext, type PlaylistFileParser } from '../../application/ports/catalog-provider.js';
import { isCatalogEmpty, type CatalogBuild } from '../../domain/catalog/model.js';
import { problemFromHttpStatus, type SourceCredential } from '../../domain/sources/source.js';
import { UpstreamError, type UpstreamClient } from '../http/upstream-client.js';
import { parsePlaylistBytes, PlaylistFormatError } from '../parsers/m3u/index.js';
import { buildCatalogFromPlaylist, isXtreamPlaylistUrl } from './m3u-catalog.js';

export interface M3uLimits {
  maxBytes: number;
  maxEntries: number;
}

const DOWNLOAD_TIMEOUT_MS = 120_000;

/** M3U/M3U8/PLS playlists: by URL (synced in the background) or uploaded as a file. */
export class M3uProvider implements CatalogProvider, PlaylistFileParser {
  constructor(
    private readonly upstream: UpstreamClient,
    private readonly limits: M3uLimits,
  ) {}

  async fetchCatalog(credential: SourceCredential, context: FetchContext): Promise<CatalogBuild> {
    if (credential.type !== 'm3u_url') throw new Error('M3uProvider only reads M3U URL sources');
    const url = new URL(credential.url);

    await context.onStage('connecting');
    const { bytes, finalUrl } = await downloadPlaylist(this.upstream, url, this.limits.maxBytes, context.signal);

    await context.onStage('parsing');
    const build = this.parse(bytes, finalUrl);
    build.xtreamCandidate = isXtreamPlaylistUrl(url);
    return build;
  }

  parseFile(bytes: Buffer, _fileName: string): CatalogBuild {
    const build = this.parse(bytes);
    if (isCatalogEmpty(build)) {
      throw new SourceFetchError('empty', 'No playable entries were found in this playlist.', { warnings: build.warnings.slice(0, 20) });
    }
    return build;
  }

  private parse(bytes: Buffer, baseUrl?: URL): CatalogBuild {
    try {
      return buildCatalogFromPlaylist(parsePlaylistBytes(bytes, { baseUrl, maxChannels: this.limits.maxEntries }));
    } catch (error) {
      if (error instanceof PlaylistFormatError) {
        throw new SourceFetchError('invalid', error.message, { reason: error.reason }, { cause: error });
      }
      throw error;
    }
  }
}

export async function downloadPlaylist(
  upstream: UpstreamClient,
  url: URL,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; finalUrl: URL }> {
  try {
    const { bytes, response } = await upstream.fetchBytes(url, maxBytes, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
    });
    return { bytes, finalUrl: response.url };
  } catch (error) {
    throw toSourceFetchError(error, url);
  }
}

/** Maps transport failures to the UX categories (auth failed / expired / unavailable …). */
export function toSourceFetchError(error: unknown, url: URL): SourceFetchError {
  if (error instanceof SourceFetchError) return error;
  if (!(error instanceof UpstreamError)) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return new SourceFetchError('unavailable', `${url.host} did not answer in time.`, undefined, { cause: error });
    }
    return new SourceFetchError('unavailable', `Could not download from ${url.host}.`, undefined, { cause: error });
  }
  switch (error.kind) {
    case 'blocked':
      return new SourceFetchError('blocked', 'This URL points to a private or local network address and cannot be used.');
    case 'too_large':
      return new SourceFetchError('too_large', 'The playlist is larger than the allowed limit.');
    case 'timeout':
      return new SourceFetchError('unavailable', `${url.host} did not answer in time.`);
    case 'status': {
      const status = error.status ?? 0;
      const problem = problemFromHttpStatus(status);
      const message =
        problem === 'auth_failed'
          ? `The provider rejected the credentials (HTTP ${status}). Check the URL, username/password or your subscription.`
          : problem === 'expired'
            ? `The playlist link no longer exists (HTTP ${status}) — it may have expired or been replaced by your provider.`
            : `The provider answered HTTP ${status}. It may be temporarily down.`;
      return new SourceFetchError(problem, message, { upstreamStatus: status });
    }
    default:
      return new SourceFetchError('unavailable', `Could not reach ${url.host}. ${error.message}`);
  }
}

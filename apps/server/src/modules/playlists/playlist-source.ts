import { UpstreamError, type UpstreamClient } from '../../infrastructure/http/upstream-client.js';
import { AppError } from '../../shared/errors.js';

export interface FetchedPlaylist {
  bytes: Buffer;
  /** Final URL after redirects — base for relative entries. */
  finalUrl: URL;
}

/** Downloads remote playlists (provider `get.php?...&type=m3u_plus`, GitHub raw, ...). */
export class PlaylistSourceFetcher {
  constructor(
    private readonly upstream: UpstreamClient,
    private readonly maxBytes: number,
  ) {}

  async fetch(url: URL): Promise<FetchedPlaylist> {
    try {
      const { bytes, response } = await this.upstream.fetchBytes(url, this.maxBytes, {
        signal: AbortSignal.timeout(60_000),
      });
      return { bytes, finalUrl: response.url };
    } catch (error) {
      throw toPlaylistSourceError(error, url);
    }
  }
}

export function toPlaylistSourceError(error: unknown, url: URL): AppError {
  if (!(error instanceof UpstreamError)) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return new AppError('UPSTREAM_ERROR', 504, `${url.host} did not answer in time.`);
    }
    return new AppError('UPSTREAM_ERROR', 502, `Could not download the playlist from ${url.host}.`, undefined, { cause: error });
  }
  switch (error.kind) {
    case 'blocked':
      return new AppError('UPSTREAM_BLOCKED', 422, 'This URL points to a private or local network address and cannot be used.');
    case 'too_large':
      return new AppError('PAYLOAD_TOO_LARGE', 413, 'The remote playlist is larger than the allowed limit.');
    case 'timeout':
      return new AppError('UPSTREAM_ERROR', 504, `${url.host} did not answer in time.`);
    case 'status':
      return new AppError(
        'UPSTREAM_ERROR',
        502,
        error.status === 401 || error.status === 403
          ? `The provider rejected the request (HTTP ${error.status}). Check the URL, credentials or subscription.`
          : `The provider answered HTTP ${error.status ?? '?'} for this playlist URL.`,
        { upstreamStatus: error.status },
      );
    default:
      return new AppError('UPSTREAM_ERROR', 502, error.message);
  }
}

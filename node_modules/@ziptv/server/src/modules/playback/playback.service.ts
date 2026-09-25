import type { PlaybackCandidateDto, PlaybackEngineName, PlaybackPlanDto, StreamKind } from '@ziptv/contracts';

import { AppError } from '../../shared/errors.js';
import { hasHeaders } from '../m3u/index.js';
import type { ChannelRecord } from '../playlists/channel.repository.js';
import { toChannelDto } from '../playlists/playlist.mapper.js';
import type { PlaylistService } from '../playlists/playlist.service.js';
import type { StreamProber } from './stream-prober.js';
import type { StreamTokenCodec } from './stream-token.js';

interface PlaybackServiceDeps {
  playlists: PlaylistService;
  tokens: StreamTokenCodec;
  prober: StreamProber;
  proxyEnabled: boolean;
  /** Builds the API path of a proxy URL for a token (keeps routing knowledge out of the service). */
  proxyPath: (token: string) => string;
}

const ENGINES_BY_KIND: Record<StreamKind, PlaybackEngineName[]> = {
  hls: ['hls'],
  dash: ['dash'],
  mpegts: ['mpegts'],
  flv: ['flv'],
  progressive: ['native'],
  // Could not be identified: try the formats IPTV panels actually serve, most likely first.
  unknown: ['hls', 'mpegts', 'native'],
};

const UNPLAYABLE_MESSAGES: Record<NonNullable<ChannelRecord['unplayableReason']>, string> = {
  unsupported_protocol: 'This channel uses a streaming protocol browsers cannot play (RTMP/RTSP/UDP). A transcoding server would be required.',
  drm: 'This channel is DRM protected and needs a license server; it cannot be played in the browser.',
  web_page: 'This entry links to a web page, not a media stream. Open it in a new tab instead.',
};

/**
 * Decides *how* a channel should be played and returns an ordered list of candidates.
 * The client stays a dumb executor: it tries candidates in order until one plays.
 *
 * Policy:
 * - direct first (no server bandwidth), unless the browser cannot possibly fetch it directly:
 *   plain http on an https page (mixed content) or headers a browser cannot set (User-Agent,
 *   Referer, Cookie...) — then the proxy goes first;
 * - proxy as fallback for CORS failures;
 * - unknown containers are probed server-side once, then cached.
 */
export class PlaybackService {
  constructor(private readonly deps: PlaybackServiceDeps) {}

  async resolve(
    ownerId: string,
    input: { playlistId: string; channelKey: string; secureContext: boolean },
  ): Promise<PlaybackPlanDto> {
    const channel = await this.deps.playlists.getChannel(ownerId, input.playlistId, input.channelKey);

    if (channel.unplayableReason) {
      throw new AppError('UNPLAYABLE', 422, UNPLAYABLE_MESSAGES[channel.unplayableReason], {
        reason: channel.unplayableReason,
        ...(channel.unplayableReason === 'web_page' ? { url: channel.url } : {}),
      });
    }

    const kind = channel.kind === 'unknown' ? await this.deps.prober.probe(channel.url, channel.headers) : channel.kind;
    const url = new URL(channel.url);
    const mixedContent = input.secureContext && url.protocol === 'http:';
    const needsHeaders = hasHeaders(channel.headers);
    const expiresAt = this.deps.tokens.newExpiry();

    const canDirect = !mixedContent;
    // DASH manifests reference segments relatively; our proxy only rewrites HLS, so DASH is direct-only.
    const canProxy = this.deps.proxyEnabled && kind !== 'dash';
    const proxyFirst = needsHeaders || mixedContent;

    const candidates: PlaybackCandidateDto[] = [];
    for (const engine of ENGINES_BY_KIND[kind]) {
      const direct: PlaybackCandidateDto = { engine, url: channel.url, via: 'direct' };
      const proxied = (): PlaybackCandidateDto => ({
        engine,
        url: this.deps.proxyPath(this.deps.tokens.issue(channel.url, channel.headers, expiresAt)),
        via: 'proxy',
      });

      if (proxyFirst) {
        if (canProxy) candidates.push(proxied());
        if (canDirect) candidates.push(direct);
      } else {
        if (canDirect) candidates.push(direct);
        if (canProxy) candidates.push(proxied());
      }
    }

    if (candidates.length === 0) {
      throw new AppError(
        'UNPLAYABLE',
        422,
        kind === 'dash'
          ? 'This MPEG-DASH stream is served over plain HTTP and cannot be played on an HTTPS page.'
          : 'This http:// stream cannot be played on an HTTPS page because the stream proxy is disabled.',
        { reason: 'mixed_content' },
      );
    }

    return {
      channel: toChannelDto({ ...channel, kind }),
      candidates,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }
}

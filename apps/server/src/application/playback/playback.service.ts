import { randomUUID } from 'node:crypto';

import type {
  AlternateStreamDto,
  ContentRefDto,
  PlaybackContentDto,
  PlaybackEventRequest,
  PlaybackPlanDto,
  ResolvePlaybackRequest,
} from '@ziptv/contracts';

import type { StreamKind, StreamLocator, UnplayableReason } from '../../domain/catalog/model.js';
import { planCandidates, type DeliveryPolicy } from '../../domain/playback/plan.js';
import { directArtwork, type ArtworkUrls } from '../catalog/artwork.js';
import { toChannelDto } from '../catalog/catalog-mapper.js';
import type { SeriesEpisodes } from '../catalog/series-episodes.js';
import type { LiveCatalogService } from '../catalog/live.service.js';
import { AppError } from '../errors.js';
import { isHiddenForViewer, type Viewer } from '../identity/viewer.js';
import type { CatalogRepository } from '../ports/catalog-repository.js';
import type { MediaUrls } from '../ports/media-urls.js';
import type { SourceRecord, SourceRepository } from '../ports/source-repository.js';
import type { StreamProber } from '../ports/stream-prober.js';
import type { SourceSecrets } from '../sources/secrets.js';
import { noopPlaybackObserver, type PlaybackObserver, type ResolvedContent, type StreamTarget, type StreamUrlResolver } from './playback-ports.js';

export interface PlaybackServiceDeps {
  live: LiveCatalogService;
  sources: SourceRepository;
  catalog: CatalogRepository;
  secrets: SourceSecrets;
  media: MediaUrls;
  prober: StreamProber;
  proxyEnabled: boolean;
  /** `proxy`: never return upstream URLs (direct candidates, web-page links) to the client. */
  delivery?: DeliveryPolicy;
  artwork?: ArtworkUrls;
  /** Builds URLs of provider-API sources (Xtream) — M3U sources carry their own locators. */
  streamUrls?: StreamUrlResolver;
  /** Episodes incl. on-demand loading of provider-API series; defaults to stored episodes only. */
  episodes?: Pick<SeriesEpisodes, 'list'>;
  observer?: PlaybackObserver;
}

const UNPLAYABLE_MESSAGES: Record<UnplayableReason, string> = {
  unsupported_protocol: 'This channel uses a streaming protocol browsers cannot play (RTMP/RTSP/UDP). A transcoding server would be required.',
  drm: 'This channel is DRM protected and needs a license server; it cannot be played in the browser.',
  web_page: 'This entry links to a web page, not a media stream. Open it in a new tab instead.',
};

const MAX_ALTERNATES = 5;

/**
 * StartPlayback: turns "play this" (channel / movie / episode / catch-up programme) into an
 * ordered list of playback candidates the client tries in turn, plus everything the player
 * shows around the stream (title, resume position, next episode, alternate streams).
 */
export class PlaybackService {
  private readonly observer: PlaybackObserver;
  private readonly delivery: DeliveryPolicy;
  private readonly artwork: ArtworkUrls;

  constructor(private readonly deps: PlaybackServiceDeps) {
    this.observer = deps.observer ?? noopPlaybackObserver;
    this.delivery = deps.delivery ?? 'auto';
    this.artwork = deps.artwork ?? directArtwork;
  }

  async resolve(viewer: Viewer, request: ResolvePlaybackRequest): Promise<PlaybackPlanDto> {
    const source = await this.deps.live.requireSource(viewer, request.content.sourceId);
    const resolved = await this.resolveContent(viewer, source, request.content);

    if (resolved.locked && !viewer.unlocked) {
      throw new AppError('PARENTAL_LOCKED', 403, 'This content is locked by parental controls. Enter the PIN to watch it.', { reason: 'parental_locked' });
    }
    if (resolved.target.unplayableReason) {
      const reason = resolved.target.unplayableReason;
      throw new AppError('UNPLAYABLE', 422, UNPLAYABLE_MESSAGES[reason], {
        reason,
        ...(reason === 'web_page' && this.delivery === 'auto' ? { url: resolved.target.locator?.url } : {}),
      });
    }

    const locator = resolved.target.locator;
    if (!locator) throw new AppError('UNPLAYABLE', 422, 'This item has no stream address.', { reason: 'unsupported_format' });

    const kind: StreamKind = resolved.target.kind === 'unknown' ? await this.deps.prober.probe(locator.url, locator.headers) : resolved.target.kind;
    if (!viewer.sessionId) throw new AppError('UNAUTHORIZED', 401, 'Sign in again to play this.');
    const grant = { kind: 'session' as const, id: viewer.sessionId };
    const expiresAt = this.deps.media.newStreamExpiry('playback');
    const candidates = planCandidates({
      kind,
      url: locator.url,
      headers: locator.headers,
      secureContext: request.secureContext,
      proxyEnabled: this.deps.proxyEnabled,
      policy: this.delivery,
      proxyUrl: () => this.deps.media.streamProxyPath(locator.url, locator.headers, expiresAt, grant),
    });
    if (candidates.length === 0) {
      if (this.delivery === 'proxy') {
        throw new AppError('UNPLAYABLE', 422, kind === 'dash' ? 'MPEG-DASH streams cannot be delivered through the ZIPTV stream proxy yet.' : 'The stream proxy is disabled.', {
          reason: 'unsupported_format',
        });
      }
      throw new AppError(
        'UNPLAYABLE',
        422,
        kind === 'dash'
          ? 'This MPEG-DASH stream is served over plain HTTP and cannot be played on an HTTPS page.'
          : 'This http:// stream cannot be played on an HTTPS page because the stream proxy is disabled.',
        { reason: 'mixed_content' },
      );
    }

    // A reconnect keeps the viewing's session (and its history entry) when it is really the same one.
    const continued = request.continueSession && this.observer.continues ? await this.observer.continues(viewer, request.continueSession, request.content) : false;
    const sessionId = continued && request.continueSession ? request.continueSession : randomUUID();
    const content: PlaybackContentDto = {
      ...resolved.content,
      image: this.artwork.url(resolved.content.image),
      channel: resolved.content.channel ? { ...resolved.content.channel, kind } : null,
    };
    const [resumeFrom, alternates] = await Promise.all([
      resolved.content.mode === 'vod' ? this.observer.resumePosition(viewer, request.content) : Promise.resolve(null),
      request.content.type === 'channel' ? this.alternates(viewer, source, resolved.nameKey) : Promise.resolve([]),
    ]);

    if (!continued) await this.observer.onPlanIssued(viewer, { sessionId, sourceName: source.name, content, seriesTitle: resolved.seriesTitle, rawImage: resolved.content.image, episode: resolved.episode ?? null });
    return {
      sessionId,
      content,
      candidates,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      resumeFrom,
      next: resolved.next,
      alternates,
    };
  }

  async recordEvent(viewer: Viewer, event: PlaybackEventRequest): Promise<void> {
    await this.observer.onEvent(viewer, event);
  }

  // ---------------------------------------------------------------------------------------

  private async resolveContent(viewer: Viewer, source: SourceRecord, ref: ContentRefDto): Promise<ResolvedContent> {
    const pin = { sourceId: source.id, revision: source.revision };
    switch (ref.type) {
      case 'channel': {
        const channel = await this.deps.catalog.findLive(pin, ref.key);
        if (!channel || isHiddenForViewer(viewer, channel)) throw AppError.notFound('Channel');
        const locked = this.deps.live.isLocked(viewer, source.id, channel);
        return {
          locked,
          nameKey: channel.nameKey,
          seriesTitle: null,
          target: await this.target(source, { kind: channel.kind, unplayableReason: channel.unplayableReason, locator: channel.locator, xtream: channel.xtream, type: 'live' }),
          content: {
            ref,
            mode: 'live',
            title: channel.name,
            subtitle: channel.groups[0] ?? null,
            image: channel.logo,
            durationSecs: null,
            channel: toChannelDto(channel, locked, this.artwork),
            programme: null,
          },
          next: null,
        };
      }
      case 'movie': {
        const movie = await this.deps.catalog.findMovie(pin, ref.key);
        if (!movie || isHiddenForViewer(viewer, movie)) throw AppError.notFound('Movie');
        return {
          locked: this.deps.live.isLocked(viewer, source.id, movie),
          nameKey: null,
          seriesTitle: null,
          target: await this.target(source, { kind: movie.kind, unplayableReason: null, locator: movie.locator, xtream: movie.xtream, type: 'movie' }),
          content: {
            ref,
            mode: 'vod',
            title: movie.name,
            subtitle: movie.year ? String(movie.year) : (movie.groups[0] ?? null),
            image: movie.poster,
            durationSecs: movie.durationSecs,
            channel: null,
            programme: null,
          },
          next: null,
        };
      }
      case 'episode': {
        const series = await this.deps.catalog.findSeries(pin, ref.seriesKey);
        if (!series || isHiddenForViewer(viewer, series)) throw AppError.notFound('Series');
        const episodes = this.deps.episodes ? await this.deps.episodes.list(source, series) : await this.deps.catalog.listEpisodes(pin, ref.seriesKey);
        const index = episodes.findIndex((episode) => episode.key === ref.key);
        const episode = episodes[index];
        if (!episode) throw AppError.notFound('Episode');
        const following = episodes[index + 1];
        return {
          locked: this.deps.live.isLocked(viewer, source.id, series),
          nameKey: null,
          seriesTitle: series.name,
          episode: { season: episode.season, episode: episode.episode },
          target: await this.target(source, { kind: episode.kind, unplayableReason: null, locator: episode.locator, xtream: episode.xtream, type: 'episode' }),
          content: {
            ref,
            mode: 'vod',
            title: episode.title,
            subtitle: `${series.name} · S${episode.season} E${episode.episode}`,
            image: episode.still ?? series.cover,
            durationSecs: episode.durationSecs,
            channel: null,
            programme: null,
          },
          next: following
            ? {
                ref: { type: 'episode', sourceId: source.id, seriesKey: series.key, key: following.key },
                title: following.title,
                subtitle: `S${following.season} E${following.episode}`,
              }
            : null,
        };
      }
      case 'catchup': {
        if (!this.deps.streamUrls?.catchup) throw new AppError('UNPLAYABLE', 422, 'Catch-up is not available for this channel.', { reason: 'unsupported_format' });
        return this.deps.streamUrls.catchup(viewer, source, ref);
      }
    }
  }

  private async target(
    source: SourceRecord,
    entry: { kind: StreamKind; unplayableReason: UnplayableReason | null; locator: string | null; xtream: { id: number; ext?: string } | null; type: 'live' | 'movie' | 'episode' },
  ): Promise<StreamTarget> {
    if (entry.xtream && this.deps.streamUrls) {
      return this.deps.streamUrls.provider(source, entry.type, entry.xtream, entry.kind);
    }
    const locator: StreamLocator | null = this.deps.secrets.openLocator(entry.locator);
    return { kind: entry.kind, unplayableReason: entry.unplayableReason, locator };
  }

  private async alternates(viewer: Viewer, source: SourceRecord, nameKey: string | null): Promise<AlternateStreamDto[]> {
    if (!nameKey) return [];
    const others = (await this.deps.sources.listByOwner(viewer.userId)).filter((other) => other.id !== source.id && other.revision > 0);
    if (others.length === 0) return [];
    const names = new Map(others.map((other) => [other.id, other.name]));
    const matches = await this.deps.catalog.findLiveByNameKey(
      others.map((other) => ({ sourceId: other.id, revision: other.revision })),
      nameKey,
      MAX_ALTERNATES * 2,
    );
    return matches
      .filter((match) => !match.unplayableReason && !isHiddenForViewer(viewer, match))
      .slice(0, MAX_ALTERNATES)
      .map((match) => ({
        ref: { type: 'channel', sourceId: match.sourceId, key: match.key },
        sourceName: names.get(match.sourceId) ?? 'Another source',
        name: match.name,
      }));
  }
}

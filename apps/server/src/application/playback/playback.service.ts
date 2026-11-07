import { randomUUID } from 'node:crypto';

import type {
  AlternateStreamDto,
  ContentRefDto,
  PlaybackContentDto,
  PlaybackEventRequest,
  PlaybackPlanDto,
  ProgrammeDto,
  ResolvePlaybackRequest,
} from '@ziptv/contracts';

import type { StreamKind, StreamLocator, UnplayableReason } from '../../domain/catalog/model.js';
import { buildCatchupUrl, catchupProblem, CatchupTemplateError, type CatchupProblem } from '../../domain/catalog/catchup-url.js';
import { planCandidates, type DeliveryPolicy } from '../../domain/playback/plan.js';
import { directArtwork, type ArtworkUrls } from '../catalog/artwork.js';
import { toChannelDto } from '../catalog/catalog-mapper.js';
import type { SeriesEpisodes } from '../catalog/series-episodes.js';
import type { OperatorVodService } from '../operator/operator-vod.service.js';
import type { OperatorService, ViewingContext } from '../operator/operator.service.js';
import type { LiveCatalogService } from '../catalog/live.service.js';
import { AppError } from '../errors.js';
import { isHiddenForViewer, type Viewer } from '../identity/viewer.js';
import type { EpgService } from '../epg/epg.service.js';
import type { CatalogRepository } from '../ports/catalog-repository.js';
import type { Clock } from '../ports/clock.js';
import type { PlaybackTelemetry } from '../health/playback-telemetry.js';
import { NOOP_METRICS, type Metrics, type TelemetrySubject } from '../ports/health.js';
import type { MediaGrant, MediaUrls } from '../ports/media-urls.js';
import type { SourceRecord, SourceRepository } from '../ports/source-repository.js';
import type { StreamProber } from '../ports/stream-prober.js';
import type { SourceSecrets } from '../sources/secrets.js';
import type { SourceConnections } from './source-connections.js';
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
  /** Operator catalog channels (rights + licensed feeds). */
  operator?: Pick<OperatorService, 'resolve'>;
  /** Operator films and series (Phase 17: the entitlement engine decides). */
  operatorVod?: Pick<OperatorVodService, 'resolveTarget'>;
  /** Episodes incl. on-demand loading of provider-API series; defaults to stored episodes only. */
  episodes?: Pick<SeriesEpisodes, 'list'>;
  observer?: PlaybackObserver;
  /** Stream health telemetry (candidate tokens, start/error reports). */
  telemetry?: Pick<PlaybackTelemetry, 'token' | 'record'>;
  metrics?: Metrics;
  /**
   * `subscription` (Phase 8): operator channels play only through an authorized playback session
   * (`POST /operator/playback/sessions`: entitlement, device, concurrency). `rights`: rights alone.
   */
  operatorAccess?: 'subscription' | 'rights';
  /** Connection limits of the subscriber's own provider accounts (Xtream `max_connections`). */
  connections?: SourceConnections;
  /** Programme titles of catch-up viewings. */
  programmes?: Pick<EpgService, 'programmeAt'>;
  /** Programme titles of operator catch-up viewings (operator EPG). */
  operatorProgrammes?: { programmeAt(channelId: string, start: Date): Promise<ProgrammeDto | null> };
  clock?: Clock;
}

const CATCHUP_MESSAGES: Record<CatchupProblem, string> = {
  not_available: 'This channel has no archive.',
  invalid_range: 'The programme times are not valid.',
  not_ended: 'This programme has not finished yet; watch it live.',
  outside_window: 'This programme is no longer in the channel archive.',
  too_long: 'Choose a single programme from the archive.',
};

function catchupError(problem: CatchupProblem): AppError {
  return new AppError('UNPLAYABLE', 422, CATCHUP_MESSAGES[problem], { reason: 'catchup_unavailable', problem });
}

/** Stream kind of an archive address: its extension when it has one, else the live kind. */
function archiveKind(url: string, live: StreamKind): StreamKind {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.ts')) return 'mpegts';
  return live;
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

  async resolve(viewer: Viewer, request: ResolvePlaybackRequest, context: ViewingContext = { country: null, device: 'web' }): Promise<PlaybackPlanDto> {
    const kind = request.content.type === 'operator' || request.content.type === 'operator_vod' ? 'operator' : 'byo';
    try {
      if (request.content.type === 'operator' && this.deps.operatorAccess === 'subscription') {
        throw new AppError('PLAYBACK_SESSION_REQUIRED', 403, 'Operator channels are played through a playback session.', { reason: 'playback_session_required' });
      }
      const plan =
        request.content.type === 'operator'
          ? await this.resolveOperator(viewer, request, request.content, context)
          : request.content.type === 'operator_vod'
            ? await this.resolveOperatorVod(viewer, request, request.content, context)
            : await this.resolveByo(viewer, request);
      (this.deps.metrics ?? NOOP_METRICS).playbackPlan(kind, 'ok');
      return plan;
    } catch (error) {
      (this.deps.metrics ?? NOOP_METRICS).playbackPlan(kind, 'error');
      throw error;
    }
  }

  /** Candidates of each target, tagged for telemetry (bound to this viewing's session id). */
  private tagged<T extends { url: string }>(parts: { candidates: T[]; subject: TelemetrySubject | undefined }[], expiresAt: number, sessionId: string): (T & { telemetry?: string })[] {
    return parts.flatMap(({ candidates, subject }) => {
      if (!subject || !this.deps.telemetry) return candidates;
      const token = this.deps.telemetry.token(subject, new Date(expiresAt * 1000), sessionId);
      return candidates.map((candidate) => ({ ...candidate, telemetry: token }));
    });
  }

  private async resolveByo(viewer: Viewer, request: ResolvePlaybackRequest): Promise<PlaybackPlanDto> {
    if (request.content.type === 'operator' || request.content.type === 'operator_vod') throw AppError.notFound('Channel');
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

    // One of the provider account's connections for this viewing (the player's previous one is freed).
    await this.deps.connections?.acquire(source, sessionId, request.replaces);
    if (!continued) await this.observer.onPlanIssued(viewer, { sessionId, sourceName: source.name, content, seriesTitle: resolved.seriesTitle, rawImage: resolved.content.image, episode: resolved.episode ?? null });
    return {
      sessionId,
      content,
      candidates: this.tagged([{ candidates, subject: { type: 'source', id: source.id } }], expiresAt, sessionId),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      resumeFrom,
      next: resolved.next,
      alternates,
    };
  }

  /**
   * Operator channels: rights decided by OperatorService; every licensed feed contributes
   * candidates in priority order (primary, then backups), and delivery is always proxied —
   * provider addresses never reach the client, whatever STREAM_DELIVERY says.
   */
  /**
   * The plan of an authorized operator viewing: its stream links are bound to the playback
   * session (`grant`), so ending the session — stop, revoked entitlement, missed heartbeats — stops
   * the stream at the proxy.
   */
  async operatorPlan(
    viewer: Viewer,
    request: { channelId: string; secureContext: boolean; continueSession?: string; archive?: { start: Date; end: Date } },
    context: ViewingContext,
    grant: MediaGrant,
  ): Promise<PlaybackPlanDto> {
    const ref: Extract<ContentRefDto, { type: 'operator' }> = request.archive
      ? { type: 'operator', channelId: request.channelId, start: request.archive.start.toISOString(), end: request.archive.end.toISOString() }
      : { type: 'operator', channelId: request.channelId };
    return this.resolveOperator(viewer, { content: ref, secureContext: request.secureContext, ...(request.continueSession ? { continueSession: request.continueSession } : {}) }, ref, context, grant);
  }

  private async resolveOperator(viewer: Viewer, request: ResolvePlaybackRequest, ref: Extract<ContentRefDto, { type: 'operator' }>, context: ViewingContext, boundTo?: MediaGrant): Promise<PlaybackPlanDto> {
    if (!this.deps.operator) throw AppError.notFound('Channel');
    if (!this.deps.proxyEnabled) throw new AppError('UNPLAYABLE', 422, 'The stream proxy is disabled.', { reason: 'unsupported_format' });
    if (!viewer.sessionId) throw new AppError('UNAUTHORIZED', 401, 'Sign in again to play this.');
    const archive = ref.start && ref.end ? { start: new Date(ref.start), end: new Date(ref.end) } : undefined;
    const resolved = await this.deps.operator.resolve(viewer, ref.channelId, context, archive);
    const grant: MediaGrant = boundTo ?? { kind: 'session', id: viewer.sessionId };
    const expiresAt = this.deps.media.newStreamExpiry('playback');
    const parts: { candidates: ReturnType<typeof planCandidates>; subject: TelemetrySubject | undefined }[] = [];
    for (const target of resolved.targets) {
      const locator = target.locator;
      if (!locator) continue;
      const kind: StreamKind = target.kind === 'unknown' ? await this.deps.prober.probe(locator.url, locator.headers) : target.kind;
      // A licensed quality limit can only be enforced on HLS (variants are filtered); other formats would bypass it.
      if (target.maxHeight && target.strictCap !== false && kind !== 'hls') continue;
      const cap = target.maxHeight && kind === 'hls' ? { maxHeight: target.maxHeight } : undefined;
      parts.push({
        candidates: planCandidates({
          kind,
          url: locator.url,
          headers: locator.headers,
          secureContext: request.secureContext,
          proxyEnabled: true,
          policy: 'proxy',
          proxyUrl: () => this.deps.media.streamProxyPath(locator.url, locator.headers, expiresAt, grant, cap),
        }),
        subject: target.telemetry,
      });
    }
    if (parts.every((part) => part.candidates.length === 0)) throw new AppError('UNPLAYABLE', 422, 'This channel cannot be delivered to this browser.', { reason: 'unsupported_format' });

    const continued = request.continueSession && this.observer.continues ? await this.observer.continues(viewer, request.continueSession, ref) : false;
    const sessionId = continued && request.continueSession ? request.continueSession : randomUUID();
    let content: PlaybackContentDto = { ...resolved.content, ref, image: this.artwork.url(resolved.content.image) };
    if (archive) {
      // The guide names the programme (operator EPG); without one the channel name stays.
      const programme = await this.deps.operatorProgrammes?.programmeAt(ref.channelId, archive.start).catch(() => null);
      if (programme) content = { ...content, title: programme.title, subtitle: resolved.content.title, programme };
    }
    if (!continued) await this.observer.onPlanIssued(viewer, { sessionId, sourceName: 'ZIPTV', content, seriesTitle: null, rawImage: resolved.rawImage, episode: null });
    return { sessionId, content, candidates: this.tagged(parts, expiresAt, sessionId), expiresAt: new Date(expiresAt * 1000).toISOString(), resumeFrom: null, next: null, alternates: [] };
  }

  /** A film/episode of the operator's VOD catalogue: entitlement first, then proxied candidates (quality-capped). */
  private async resolveOperatorVod(viewer: Viewer, request: ResolvePlaybackRequest, ref: Extract<ContentRefDto, { type: 'operator_vod' }>, context: ViewingContext): Promise<PlaybackPlanDto> {
    if (!this.deps.operatorVod) throw AppError.notFound('Title');
    if (!this.deps.proxyEnabled) throw new AppError('UNPLAYABLE', 422, 'The stream proxy is disabled.', { reason: 'unsupported_format' });
    if (!viewer.sessionId) throw new AppError('UNAUTHORIZED', 401, 'Sign in again to play this.');
    const resolved = await this.deps.operatorVod.resolveTarget(viewer, context, ref.vodId, ref.episodeId);
    const locator = resolved.target.locator!;
    const grant: MediaGrant = { kind: 'session', id: viewer.sessionId };
    const expiresAt = this.deps.media.newStreamExpiry('playback');
    const kind: StreamKind = resolved.target.kind === 'unknown' ? await this.deps.prober.probe(locator.url, locator.headers) : resolved.target.kind;
    if (resolved.target.maxHeight && resolved.target.strictCap !== false && kind !== 'hls') throw new AppError('UNPLAYABLE', 422, 'This title cannot be delivered at the licensed quality.', { reason: 'unsupported_format' });
    const cap = resolved.target.maxHeight && kind === 'hls' ? { maxHeight: resolved.target.maxHeight } : undefined;
    const candidates = planCandidates({ kind, url: locator.url, headers: locator.headers, secureContext: request.secureContext, proxyEnabled: true, policy: 'proxy', proxyUrl: () => this.deps.media.streamProxyPath(locator.url, locator.headers, expiresAt, grant, cap) });
    if (candidates.length === 0) throw new AppError('UNPLAYABLE', 422, 'This title cannot be delivered to this browser.', { reason: 'unsupported_format' });
    const sessionId = randomUUID();
    const content: PlaybackContentDto = { ...resolved.content, ref, image: this.artwork.url(resolved.content.image) };
    return { sessionId, content, candidates, expiresAt: new Date(expiresAt * 1000).toISOString(), resumeFrom: null, next: null, alternates: [] };
  }

  async recordEvent(viewer: Viewer, event: PlaybackEventRequest): Promise<void> {
    await Promise.all([this.observer.onEvent(viewer, event), this.deps.telemetry?.record(event), this.trackConnection(viewer, event)]);
  }

  /** Heartbeats keep a viewing's provider connection; `stop` frees it. Best-effort: never fails the event. */
  private async trackConnection(viewer: Viewer, event: PlaybackEventRequest): Promise<void> {
    const connections = this.deps.connections;
    if (!connections || !this.observer.sourceOf || event.type === 'error') return;
    try {
      const sourceId = await this.observer.sourceOf(viewer, event.sessionId);
      if (!sourceId) return;
      if (event.type === 'stop') return await connections.release(sourceId, event.sessionId);
      const source = await this.deps.sources.findOwned(sourceId, viewer.userId);
      if (source) await connections.renew(source, event.sessionId);
    } catch {
      // The lease simply expires; playback is unaffected.
    }
  }

  // ---------------------------------------------------------------------------------------

  private async resolveContent(viewer: Viewer, source: SourceRecord, ref: Exclude<ContentRefDto, { type: 'operator' | 'operator_vod' }>): Promise<ResolvedContent> {
    const pin = { sourceId: source.id, revision: source.revision };
    switch (ref.type) {
      case 'channel': {
        const channel = await this.deps.catalog.findLive(pin, ref.key);
        if (!channel || isHiddenForViewer(viewer, channel, source.id)) throw AppError.notFound('Channel');
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
        if (!movie || isHiddenForViewer(viewer, movie, source.id)) throw AppError.notFound('Movie');
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
        if (!series || isHiddenForViewer(viewer, series, source.id)) throw AppError.notFound('Series');
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
      case 'catchup':
        return this.resolveCatchup(viewer, source, ref);
    }
  }

  /**
   * A past programme of a BYO live channel: the same visibility and parental rules as the
   * channel, inside its archive window, at most one programme long; the archive URL is built
   * server-side from the (encrypted) stream address or Xtream account.
   */
  private async resolveCatchup(viewer: Viewer, source: SourceRecord, ref: Extract<ContentRefDto, { type: 'catchup' }>): Promise<ResolvedContent> {
    const pin = { sourceId: source.id, revision: source.revision };
    const channel = await this.deps.catalog.findLive(pin, ref.key);
    if (!channel || isHiddenForViewer(viewer, channel, source.id)) throw AppError.notFound('Channel');
    const range = { start: new Date(ref.start), end: new Date(ref.end) };
    const problem = catchupProblem(channel.catchup?.days, range, this.now());
    if (problem) throw catchupError(problem);
    const info = channel.catchup!;

    let target: StreamTarget;
    if (channel.xtream && (info.mode === 'xtream' || !channel.locator)) {
      if (!this.deps.streamUrls?.archive) throw catchupError('not_available');
      target = await this.deps.streamUrls.archive(source, channel.xtream, range);
    } else {
      const live = await this.target(source, { kind: channel.kind, unplayableReason: channel.unplayableReason, locator: channel.locator, xtream: channel.xtream, type: 'live' });
      if (!live.locator) throw catchupError('not_available');
      let url: string | null;
      try {
        url = buildCatchupUrl(info, live.locator.url, { ...range, now: this.now() });
      } catch (error) {
        if (error instanceof CatchupTemplateError) throw new AppError('UNPLAYABLE', 422, `${error.message} This archive cannot be played.`, { reason: 'unsupported_format' });
        throw error;
      }
      if (!url) throw catchupError('not_available');
      target = { kind: archiveKind(url, channel.kind), unplayableReason: live.unplayableReason, locator: { url, headers: live.locator.headers } };
    }

    const locked = this.deps.live.isLocked(viewer, source.id, channel);
    const programme = (await this.deps.programmes?.programmeAt(viewer, source.id, channel.key, range.start).catch(() => null)) ?? null;
    return {
      locked,
      nameKey: null,
      seriesTitle: null,
      target,
      content: {
        ref,
        mode: 'catchup',
        title: programme?.title ?? channel.name,
        subtitle: programme ? channel.name : `${channel.name} · archive`,
        image: channel.logo,
        durationSecs: Math.round((range.end.getTime() - range.start.getTime()) / 1000),
        channel: toChannelDto(channel, locked, this.artwork),
        programme,
      },
      next: null,
    };
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock.now() : new Date();
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
      .filter((match) => !match.unplayableReason && !isHiddenForViewer(viewer, match, match.sourceId))
      .slice(0, MAX_ALTERNATES)
      .map((match) => ({
        ref: { type: 'channel', sourceId: match.sourceId, key: match.key },
        sourceName: names.get(match.sourceId) ?? 'Another source',
        name: match.name,
      }));
  }
}

import type { OperatorVodDetailDto, OperatorVodItemDto, OperatorVodPageDto, PlaybackContentDto } from '@ziptv/contracts';

import type { StreamLocator } from '../../domain/catalog/model.js';
import { licensedRight, type VodDenial } from '../../domain/commerce/plan.js';
import { QUALITY_HEIGHT } from '../../domain/operator/vendor-feed.js';
import { directArtwork, type ArtworkUrls } from '../catalog/artwork.js';
import type { EntitlementService, VodVerdict } from '../commerce/entitlement.service.js';
import { AppError } from '../errors.js';
import type { Viewer } from '../identity/viewer.js';
import type { Clock } from '../ports/clock.js';
import type { ProviderFeedRepository, VodCatalogItem } from '../ports/provider-feed-repository.js';
import type { StreamTarget } from '../playback/playback-ports.js';
import type { ViewingContext } from './operator.service.js';

const DENIAL_MESSAGES: Record<VodDenial, string> = {
  account_blocked: 'This account is blocked. Contact support.',
  not_licensed: 'This title is not available here.',
  no_subscription: 'Subscribe to a plan with films and series to watch this.',
  not_in_plan: 'This title is not in your plan.',
};

/**
 * The operator's films and series for one viewer (Phase 17.4): what the vendors license here,
 * each marked by the entitlement engine — in the viewer's plan, in a plan they could switch to,
 * or not sold — and, for what their plan includes, the stream to play. One engine decides for
 * the catalogue, the UI badges and playback.
 */
export class OperatorVodService {
  constructor(
    private readonly deps: {
      feeds: Pick<ProviderFeedRepository, 'vodCatalog' | 'vodItem'>;
      entitlements: EntitlementService;
      clock: Clock;
      openLocator: (sealed: string | null) => StreamLocator | null;
      artwork?: ArtworkUrls;
    },
  ) {}

  private get artwork(): ArtworkUrls {
    return this.deps.artwork ?? directArtwork;
  }

  async list(viewer: Viewer, context: ViewingContext, query: { type?: 'movie' | 'series' | undefined; q?: string | undefined; limit: number; offset: number }): Promise<OperatorVodPageDto> {
    // Vendor feeds carry no age ratings yet: kids profiles do not see the operator's films.
    if (viewer.kids) return { items: [], total: 0 };
    const page = await this.deps.feeds.vodCatalog({ country: context.country, device: context.device, at: this.deps.clock.now(), type: query.type, q: query.q, limit: query.limit, offset: query.offset });
    const verdicts = await this.deps.entitlements.vod(viewer, page.items.map(toView), context);
    return { items: page.items.map((item) => this.toItemDto(item, verdicts.get(item.id))), total: page.total };
  }

  async detail(viewer: Viewer, context: ViewingContext, id: string): Promise<OperatorVodDetailDto> {
    const item = await this.licensedItem(viewer, context, id);
    const verdict = (await this.deps.entitlements.vod(viewer, [toView(item)], context)).get(item.id);
    return {
      ...this.toItemDto(item, verdict),
      plot: item.plot,
      durationSecs: item.durationSecs,
      episodes: item.episodes.map((episode) => ({ id: episode.externalId, season: episode.season, episode: episode.episode, title: episode.title, durationSecs: episode.durationSecs })),
    };
  }

  /**
   * What playing a film (or an episode) needs: the entitlement decision, then the stream with the
   * quality ceiling (licence × plan). Refused with the reason and the plans that would open it.
   */
  async resolveTarget(viewer: Viewer, context: ViewingContext, vodId: string, episodeId?: string): Promise<{ content: Omit<PlaybackContentDto, 'ref'>; rawImage: string | null; target: StreamTarget }> {
    const item = await this.licensedItem(viewer, context, vodId);
    const verdict = (await this.deps.entitlements.vod(viewer, [toView(item)], context)).get(item.id);
    const decision = verdict?.decision;
    if (!decision?.allowed) {
      const reason = decision?.reason ?? 'not_licensed';
      throw new AppError('NOT_ENTITLED', 403, DENIAL_MESSAGES[reason], { reason, packages: verdict?.upgrade ?? [] });
    }
    const episode = item.type === 'series' ? item.episodes.find((candidate) => candidate.externalId === episodeId) : undefined;
    if (item.type === 'series' && !episode) throw AppError.notFound('Episode');
    const locator = this.deps.openLocator(episode ? episode.locator : item.locator);
    if (!locator) throw new AppError('UNPLAYABLE', 503, 'This title is temporarily unavailable.', { reason: 'no_feed' });
    // A licence ceiling cannot be bypassed by a format that cannot be limited; a plan-only ceiling can be skipped there.
    const licensed = licensedRight(item.rights, { ...context, at: this.deps.clock.now(), model: 'subscription' }) ?? licensedRight(item.rights, { ...context, at: this.deps.clock.now(), model: 'b2b' });
    const cap = decision.maxQuality;
    return {
      content: {
        mode: 'vod',
        title: episode ? episode.title : item.title,
        subtitle: episode ? `${item.title} · S${episode.season} E${episode.episode}` : item.year ? String(item.year) : null,
        image: item.poster,
        durationSecs: episode ? episode.durationSecs : item.durationSecs,
        channel: null,
        programme: null,
      },
      rawImage: item.poster,
      target: { kind: 'unknown', unplayableReason: null, locator, ...(cap ? { maxHeight: QUALITY_HEIGHT[cap], strictCap: (licensed?.maxQuality ?? null) !== null } : {}) },
    };
  }

  private async licensedItem(viewer: Viewer, context: ViewingContext, id: string) {
    if (viewer.kids) throw AppError.notFound('Title');
    const item = await this.deps.feeds.vodItem(id);
    const now = this.deps.clock.now();
    // Not licensed here (country, device, window): as if it did not exist.
    if (!item || (!licensedRight(item.rights, { ...context, at: now, model: 'subscription' }) && !licensedRight(item.rights, { ...context, at: now, model: 'b2b' }))) throw AppError.notFound('Title');
    return item;
  }

  private toItemDto(item: VodCatalogItem, verdict: VodVerdict | undefined): OperatorVodItemDto {
    const decision = verdict?.decision;
    const access: OperatorVodItemDto['access'] = decision?.allowed ? 'included' : verdict && verdict.upgrade.length > 0 ? 'upgrade' : 'unavailable';
    return {
      id: item.id,
      type: item.type,
      title: item.title,
      year: item.year,
      poster: this.artwork.url(item.poster),
      genres: item.genres,
      rating: item.rating,
      access,
      plans: access === 'upgrade' ? verdict!.upgrade : [],
      maxQuality: decision?.allowed ? decision.maxQuality : null,
    };
  }
}

const toView = (item: VodCatalogItem) => ({ id: item.id, packages: item.packageIds, rights: item.rights });

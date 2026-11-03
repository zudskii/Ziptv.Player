import type { ListItemDto, OperatorChannelDto, OperatorChannelListDto, OperatorFavoritesImportDto, OperatorLineupDto, PlaybackContentDto } from '@ziptv/contracts';

import { aliasKeys, type DeviceClass } from '../../domain/operator/catalog.js';
import { playableFeeds } from '../../domain/operator/feeds.js';
import { denialReason, findCoveringGrant, isLicensedAt, type RightsQuery } from '../../domain/operator/rights.js';
import { directArtwork, type ArtworkUrls } from '../catalog/artwork.js';
import { AppError } from '../errors.js';
import type { Viewer } from '../identity/viewer.js';
import type { Cache } from '../ports/cache.js';
import type { CatalogRepository } from '../ports/catalog-repository.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { CategoryRecord, LineupRecord, MasterChannelRecord, OperatorCatalogRepository, ProviderAdapters, StoredGrant } from '../ports/operator.js';
import type { SourceRepository } from '../ports/source-repository.js';
import type { ListRepository } from '../ports/user-state-repository.js';
import type { StreamTarget } from '../playback/playback-ports.js';
import { invalidateHome } from '../user-state/cache-keys.js';
import type { ProviderConnections } from './provider-connections.js';

/** Where and on what the viewer watches. `country` is decided by the server (never the client) for playback. */
export interface ViewingContext {
  country: string | null;
  device: DeviceClass;
}

/** Cache prefix of operator catalog reads (cleared by every console write). */
export const OPERATOR_CACHE_PREFIX = 'operator:';
const SNAPSHOT_TTL_MS = 60_000;

interface CatalogSnapshot {
  channels: MasterChannelRecord[];
  grants: Map<string, StoredGrant[]>;
  categories: Map<string, CategoryRecord>;
}

/**
 * Viewer side of the operator catalog. The business invariant lives here: a channel is listed
 * and played only while an active rights grant covers the viewer's market, device and time, and
 * a licensed feed is available. Delivery is always through the stream proxy: provider addresses
 * and credentials never reach the client.
 */
export class OperatorService {
  constructor(
    private readonly deps: {
      catalog: OperatorCatalogRepository;
      adapters: ProviderAdapters;
      connections: ProviderConnections;
      sources: SourceRepository;
      byoCatalog: CatalogRepository;
      list: ListRepository;
      cache: Cache;
      clock: Clock;
      logger: Logger;
      artwork?: ArtworkUrls;
    },
  ) {}

  private get artwork(): ArtworkUrls {
    return this.deps.artwork ?? directArtwork;
  }

  async channels(viewer: Viewer, context: ViewingContext, lineupSlug?: string): Promise<OperatorChannelListDto> {
    const query: RightsQuery = { country: context.country, device: context.device, at: this.deps.clock.now() };
    const [snapshot, lineups, favorites] = await Promise.all([this.snapshot(), context.country ? this.lineupsOf(context.country) : Promise.resolve([]), this.deps.catalog.favorites(viewer.profileId)]);
    const lineup = lineupSlug ? lineups.find((item) => item.slug === lineupSlug) : undefined;
    if (lineupSlug && !lineup) throw AppError.notFound('Lineup');
    const numbers = lineup ? new Map((await this.lineupEntries(lineup.id)).map((entry) => [entry.channelId, entry.number])) : null;
    const favoriteIds = new Set(favorites.map((favorite) => favorite.channelId));

    const channels: OperatorChannelDto[] = [];
    for (const channel of snapshot.channels) {
      if (numbers && !numbers.has(channel.id)) continue;
      if (!findCoveringGrant(snapshot.grants.get(channel.id) ?? [], query)) continue;
      if (this.hidesAdult(viewer) && this.isAdult(snapshot, channel)) continue;
      channels.push(this.toChannelDto(snapshot, channel, numbers?.get(channel.id) ?? null, favoriteIds.has(channel.id)));
    }
    channels.sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
    return { country: context.country, device: context.device, lineup: lineup ? toLineupDto(lineup) : null, lineups: lineups.map(toLineupDto), channels };
  }

  /**
   * Playback of a master channel: rights for the server-determined market → licensed feeds in
   * priority order (primary first, backups after) → upstream addresses from the connectors.
   */
  async resolve(viewer: Viewer, channelId: string, context: ViewingContext): Promise<{ content: Omit<PlaybackContentDto, 'ref'>; rawImage: string | null; targets: StreamTarget[] }> {
    const snapshot = await this.snapshot();
    const channel = snapshot.channels.find((item) => item.id === channelId);
    if (!channel || (this.hidesAdult(viewer) && this.isAdult(snapshot, channel))) throw AppError.notFound('Channel');
    const query: RightsQuery = { country: context.country, device: context.device, at: this.deps.clock.now() };
    const grants = snapshot.grants.get(channel.id) ?? [];
    if (!findCoveringGrant(grants, query)) {
      const reason = denialReason(grants, query);
      throw new AppError(
        'NOT_ENTITLED',
        403,
        reason === 'territory' ? 'This channel is not available in your country.' : reason === 'device' ? 'This channel is not available on this device.' : 'This channel is not available right now.',
        { reason },
      );
    }

    const targets: StreamTarget[] = [];
    for (const feed of playableFeeds(await this.deps.catalog.feedsOf([channel.id]))) {
      try {
        const [stream, provider] = await Promise.all([this.deps.catalog.findStream(feed.providerStreamId), this.deps.catalog.findProvider(feed.providerId)]);
        if (!stream || !provider) continue;
        const connection = await this.deps.connections.open(provider);
        const locator = await this.deps.adapters[provider.type].resolveFeed(provider, connection, stream);
        targets.push({ kind: stream.kind, unplayableReason: null, locator });
      } catch (error) {
        // One broken feed must not hide the others (backup feeds exist for exactly this).
        this.deps.logger.warn({ err: error, feedId: feed.id, channelId: channel.id }, 'Feed could not be resolved');
      }
    }
    if (targets.length === 0) throw new AppError('UNPLAYABLE', 503, 'This channel is temporarily unavailable.', { reason: 'no_feed' });

    const category = channel.categoryId ? (snapshot.categories.get(channel.categoryId)?.name ?? null) : null;
    return {
      content: { mode: 'live', title: channel.name, subtitle: category, image: channel.logo, durationSecs: null, channel: null, programme: null },
      rawImage: channel.logo,
      targets,
    };
  }

  // --- favourites (keyed by channel_master.id) ---------------------------------------------------

  async addFavorite(viewer: Viewer, channelId: string): Promise<void> {
    const snapshot = await this.snapshot();
    const channel = snapshot.channels.find((item) => item.id === channelId);
    if (!channel || (this.hidesAdult(viewer) && this.isAdult(snapshot, channel))) throw AppError.notFound('Channel');
    await this.deps.catalog.addFavorite(viewer.profileId, channel.id);
    invalidateHome(this.deps.cache, viewer.profileId);
  }

  async removeFavorite(viewer: Viewer, channelId: string): Promise<void> {
    await this.deps.catalog.removeFavorite(viewer.profileId, channelId);
    invalidateHome(this.deps.cache, viewer.profileId);
  }

  /**
   * My List entries for operator favourites (`type: 'operator'`, `key` = channel id). `available`
   * = still carried and licensed somewhere now; a market/device mismatch is explained when played
   * (a favourite saved at home stays on the list while travelling).
   */
  async favoriteListItems(viewer: Viewer): Promise<ListItemDto[]> {
    const favorites = await this.deps.catalog.favorites(viewer.profileId);
    if (favorites.length === 0) return [];
    const snapshot = await this.snapshot();
    const byId = new Map(snapshot.channels.map((channel) => [channel.id, channel]));
    const now = this.deps.clock.now();
    const stored = new Map((await this.deps.catalog.findChannels(favorites.map((favorite) => favorite.channelId))).map((channel) => [channel.id, channel]));
    return favorites.flatMap((favorite) => {
      const channel = byId.get(favorite.channelId) ?? stored.get(favorite.channelId);
      if (!channel || (this.hidesAdult(viewer) && this.isAdult(snapshot, channel))) return [];
      return [
        {
          type: 'operator' as const,
          sourceId: '',
          key: channel.id,
          title: channel.name,
          image: this.artwork.url(channel.logo),
          subtitle: channel.categoryId ? (snapshot.categories.get(channel.categoryId)?.name ?? null) : null,
          addedAt: favorite.addedAt.toISOString(),
          available: byId.has(channel.id) && isLicensedAt(snapshot.grants.get(channel.id) ?? [], now),
        },
      ];
    });
  }

  /**
   * BYO → operator: channels on the viewer's My List (from their own sources) that the operator
   * carries — matched by the same dedup keys as ingestion — become operator favourites.
   */
  async importFavoritesFromMyList(viewer: Viewer, context: ViewingContext): Promise<OperatorFavoritesImportDto> {
    const items = (await this.deps.list.list(viewer.profileId, 1_000)).filter((item) => item.type === 'channel');
    if (items.length === 0) return { added: 0 };
    const sources = new Map((await this.deps.sources.listByOwner(viewer.userId)).filter((source) => source.revision > 0).map((source) => [source.id, source]));
    const keys: ReturnType<typeof aliasKeys> = [];
    for (const item of items) {
      const source = sources.get(item.sourceId);
      const [channel] = source ? await this.deps.byoCatalog.findLiveMany({ sourceId: source.id, revision: source.revision }, [item.key]) : [];
      keys.push(...aliasKeys({ name: channel?.name ?? item.title, tvgId: channel?.tvgId ?? null }));
    }
    const matches = await this.deps.catalog.channelsByAlias(keys);
    const visible = new Set((await this.channels(viewer, context)).channels.map((channel) => channel.id));
    const existing = new Set((await this.deps.catalog.favorites(viewer.profileId)).map((favorite) => favorite.channelId));
    let added = 0;
    for (const channelId of new Set(matches.values())) {
      if (!visible.has(channelId) || existing.has(channelId)) continue;
      await this.deps.catalog.addFavorite(viewer.profileId, channelId);
      added++;
    }
    if (added > 0) invalidateHome(this.deps.cache, viewer.profileId);
    return { added };
  }

  forget(): void {
    this.deps.cache.deleteByPrefix(OPERATOR_CACHE_PREFIX);
  }

  // ---------------------------------------------------------------------------------------------

  /** Channels with a playable feed, their grants and categories — shared by every viewer for a minute. */
  private snapshot(): Promise<CatalogSnapshot> {
    return this.deps.cache.wrap(`${OPERATOR_CACHE_PREFIX}snapshot`, SNAPSHOT_TTL_MS, async () => {
      const channels = await this.deps.catalog.activeChannelsWithFeeds();
      const [grants, categories] = await Promise.all([this.deps.catalog.grantsOf(channels.map((channel) => channel.id)), this.deps.catalog.listCategories()]);
      const byChannel = new Map<string, StoredGrant[]>();
      for (const grant of grants) byChannel.set(grant.channelId, [...(byChannel.get(grant.channelId) ?? []), grant]);
      return { channels, grants: byChannel, categories: new Map(categories.map((category) => [category.id, category])) };
    });
  }

  private lineupsOf(country: string): Promise<LineupRecord[]> {
    return this.deps.cache.wrap(`${OPERATOR_CACHE_PREFIX}lineups:${country}`, SNAPSHOT_TTL_MS, () => this.deps.catalog.lineupsForCountry(country));
  }

  private lineupEntries(lineupId: string): Promise<{ channelId: string; number: number }[]> {
    return this.deps.cache.wrap(`${OPERATOR_CACHE_PREFIX}lineup:${lineupId}`, SNAPSHOT_TTL_MS, () => this.deps.catalog.lineupEntries(lineupId));
  }

  private hidesAdult(viewer: Viewer): boolean {
    return viewer.kids || viewer.hideAdult;
  }

  private isAdult(snapshot: CatalogSnapshot, channel: MasterChannelRecord): boolean {
    const category = channel.categoryId ? snapshot.categories.get(channel.categoryId) : undefined;
    return category?.slug === 'adult';
  }

  private toChannelDto(snapshot: CatalogSnapshot, channel: MasterChannelRecord, number: number | null, favorite: boolean): OperatorChannelDto {
    return {
      id: channel.id,
      number,
      name: channel.name,
      logo: this.artwork.url(channel.logo),
      category: channel.categoryId ? (snapshot.categories.get(channel.categoryId)?.name ?? null) : null,
      languages: channel.languages,
      favorite,
    };
  }
}

function toLineupDto(lineup: LineupRecord): OperatorLineupDto {
  return { slug: lineup.slug, name: lineup.name, country: lineup.country };
}

import type { ListItemDto, OperatorChannelDto, OperatorChannelListDto, OperatorFavoritesImportDto, OperatorLineupDto, PlaybackContentDto } from '@ziptv/contracts';

import { aliasKeys, type DeviceClass } from '../../domain/operator/catalog.js';
import { playbackOrder } from '../../domain/health/failover.js';
import { playableFeeds } from '../../domain/operator/feeds.js';
import { catchupProblem, type CatchupProblem } from '../../domain/catalog/catchup-url.js';
import { catchupDaysFor, catchupGrants, denialReason, findCoveringGrant, isLicensedAt, qualityCapFor, type RightsQuery } from '../../domain/operator/rights.js';
import { QUALITY_HEIGHT } from '../../domain/operator/vendor-feed.js';
import { directArtwork, type ArtworkUrls } from '../catalog/artwork.js';
import { AppError } from '../errors.js';
import { OPERATOR_LOCK_SOURCE } from '../../domain/viewer/parental.js';
import { inLibrary, lockKey, type Viewer } from '../identity/viewer.js';
import type { Cache } from '../ports/cache.js';
import type { CatalogRepository } from '../ports/catalog-repository.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { EntitlementService } from '../commerce/entitlement.service.js';
import type { HealthRepository } from '../ports/health.js';
import type { CategoryRecord, FeedRecord, LineupRecord, MasterChannelRecord, OperatorCatalogRepository, ProviderAdapters, StoredGrant } from '../ports/operator.js';
import type { SourceRepository } from '../ports/source-repository.js';
import type { ListRepository } from '../ports/user-state-repository.js';
import type { StreamTarget } from '../playback/playback-ports.js';
import { invalidateHome } from '../user-state/cache-keys.js';
import { FeedLocators } from './feed-locators.js';
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
  /** Longest archive among the channel's playable feeds (days; 0 = no catch-up). */
  archiveDays: Map<string, number>;
}

/** A past programme to replay (catch-up). */
export interface ArchiveRange {
  start: Date;
  end: Date;
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
      /** Commerce (Phase 8): locked channels in the list. */
      entitlements?: Pick<EntitlementService, 'annotate'>;
      /** Health and failover state (Phase 7); without it feeds are tried in priority order. */
      health?: Pick<HealthRepository, 'feedHealthOf' | 'failoverOf'>;
    },
  ) {
    this.locators = new FeedLocators(deps);
  }

  private readonly locators: FeedLocators;

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
      if (this.concealed(viewer, snapshot, channel)) continue;
      channels.push({ ...this.toChannelDto(snapshot, channel, numbers?.get(channel.id) ?? null, favoriteIds.has(channel.id), query), parentalLock: this.parentalLocked(viewer, snapshot, channel) });
    }
    // Commerce: mark channels the viewer's packages do not cover (and which packages would).
    const annotations = this.deps.entitlements ? await this.deps.entitlements.annotate(viewer, channels.map((channel) => ({ id: channel.id, grants: snapshot.grants.get(channel.id) ?? [] })), context) : new Map();
    for (const channel of channels) Object.assign(channel, annotations.get(channel.id) ?? {});
    channels.sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
    return { country: context.country, device: context.device, lineup: lineup ? toLineupDto(lineup) : null, lineups: lineups.map(toLineupDto), channels };
  }

  /**
   * Playback of a master channel: rights for the server-determined market → licensed feeds in
   * priority order (primary first, backups after) → upstream addresses from the connectors.
   */
  async resolve(viewer: Viewer, channelId: string, context: ViewingContext, archive?: ArchiveRange): Promise<{ content: Omit<PlaybackContentDto, 'ref'>; rawImage: string | null; targets: StreamTarget[] }> {
    const snapshot = await this.snapshot();
    const channel = snapshot.channels.find((item) => item.id === channelId);
    if (!channel || this.concealed(viewer, snapshot, channel)) throw AppError.notFound('Channel');
    const query: RightsQuery = { country: context.country, device: context.device, at: this.deps.clock.now() };
    const grants = snapshot.grants.get(channel.id) ?? [];
    this.assertUnlocked(viewer, snapshot, channel);
    if (archive) return this.resolveArchive(snapshot, channel, grants, query, archive);
    if (!findCoveringGrant(grants, query)) {
      const reason = denialReason(grants, query);
      throw new AppError(
        'NOT_ENTITLED',
        403,
        reason === 'territory' ? 'This channel is not available in your country.' : reason === 'device' ? 'This channel is not available on this device.' : 'This channel is not available right now.',
        { reason },
      );
    }

    // The licence may cap the picture quality (the most generous covering grant decides).
    const cap = qualityCapFor(grants, query);
    const targets: StreamTarget[] = [];
    for (const feed of await this.orderedFeeds(channel.id)) {
      try {
        const located = await this.locators.locate(feed);
        if (!located) continue;
        targets.push({ kind: located.kind, unplayableReason: null, locator: located.locator, telemetry: { type: 'feed', id: feed.id }, ...(cap ? { maxHeight: QUALITY_HEIGHT[cap] } : {}) });
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

  /**
   * Catch-up of a master channel: catch-up rights that cover the viewer now *and* covered the
   * broadcast, within both the licensed window and the provider's archive of each feed; feeds in
   * failover order, archive addresses built server-side.
   */
  private async resolveArchive(snapshot: CatalogSnapshot, channel: MasterChannelRecord, grants: StoredGrant[], query: RightsQuery, range: ArchiveRange) {
    const licensed = catchupGrants(grants, query, range.start);
    if (licensed.length === 0) {
      throw new AppError('NOT_ENTITLED', 403, findCoveringGrant(grants, query) ? 'Catch-up is not licensed for this programme.' : 'This channel is not available here.', { reason: 'catchup_not_licensed' });
    }
    const licensedDays = Math.max(...licensed.map((grant) => grant.catchupDays));
    const cap = qualityCapFor(licensed, query);
    const now = query.at;
    const targets: StreamTarget[] = [];
    let problem: CatchupProblem | null = 'not_available';
    for (const feed of await this.orderedFeeds(channel.id)) {
      const feedProblem = catchupProblem(Math.min(licensedDays, feed.archiveDays), range, now);
      if (feedProblem) {
        if (problem === 'not_available') problem = feedProblem;
        continue;
      }
      try {
        const located = await this.locators.locateArchive(feed, { ...range, now });
        if (!located) continue;
        targets.push({ kind: located.kind, unplayableReason: null, locator: located.locator, telemetry: { type: 'feed', id: feed.id }, ...(cap ? { maxHeight: QUALITY_HEIGHT[cap] } : {}) });
      } catch (error) {
        this.deps.logger.warn({ err: error, feedId: feed.id, channelId: channel.id }, 'Archive of a feed could not be resolved');
      }
    }
    if (targets.length === 0) {
      throw new AppError('UNPLAYABLE', 422, problem === 'outside_window' ? 'This programme is no longer in the archive.' : problem === 'not_ended' ? 'This programme has not finished yet; watch it live.' : 'This programme cannot be replayed.', { reason: 'catchup_unavailable', problem });
    }
    const category = channel.categoryId ? (snapshot.categories.get(channel.categoryId)?.name ?? null) : null;
    return {
      content: { mode: 'catchup' as const, title: channel.name, subtitle: category, image: channel.logo, durationSecs: Math.round((range.end.getTime() - range.start.getTime()) / 1000), channel: null, programme: null },
      rawImage: channel.logo,
      targets,
    };
  }

  /** Days of archive the viewer may replay on a channel here and now (0 = none). */
  async catchupDays(channelId: string, context: ViewingContext): Promise<number> {
    const snapshot = await this.snapshot();
    return this.availableArchive(snapshot, channelId, { country: context.country, device: context.device, at: this.deps.clock.now() });
  }

  /** Parental: the channel needs the PIN (an unlock token) before a viewing can start. */
  async assertViewable(viewer: Viewer, channelId: string): Promise<void> {
    const snapshot = await this.snapshot();
    const channel = snapshot.channels.find((item) => item.id === channelId);
    if (!channel || this.concealed(viewer, snapshot, channel)) throw AppError.notFound('Channel');
    this.assertUnlocked(viewer, snapshot, channel);
  }

  private assertUnlocked(viewer: Viewer, snapshot: CatalogSnapshot, channel: MasterChannelRecord): void {
    if (this.parentalLocked(viewer, snapshot, channel)) {
      throw new AppError('PARENTAL_LOCKED', 403, 'This channel is locked by parental controls. Enter the PIN to watch it.', { reason: 'parental_locked' });
    }
  }

  /** What authorization needs to know about a channel this viewer can see (its grants). */
  async accessContext(viewer: Viewer, channelId: string): Promise<{ channel: { id: string; name: string }; grants: StoredGrant[] }> {
    const snapshot = await this.snapshot();
    const channel = snapshot.channels.find((item) => item.id === channelId);
    if (!channel || this.concealed(viewer, snapshot, channel)) throw AppError.notFound('Channel');
    return { channel: { id: channel.id, name: channel.name }, grants: snapshot.grants.get(channel.id) ?? [] };
  }

  // --- favourites (keyed by channel_master.id) ---------------------------------------------------

  async addFavorite(viewer: Viewer, channelId: string): Promise<void> {
    const snapshot = await this.snapshot();
    const channel = snapshot.channels.find((item) => item.id === channelId);
    if (!channel || this.concealed(viewer, snapshot, channel)) throw AppError.notFound('Channel');
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
      if (!channel || this.concealed(viewer, snapshot, channel)) return [];
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
    const sources = new Map(inLibrary(viewer, await this.deps.sources.listByOwner(viewer.userId)).filter((source) => source.revision > 0).map((source) => [source.id, source]));
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

  /**
   * Playable feeds in failover order: the channel's active feed first (as chosen by the health
   * evaluator or pinned by an operator), then working before failing feeds, by priority; feeds in
   * maintenance are left out. Without health data this is plain priority order.
   */
  private async orderedFeeds(channelId: string): Promise<FeedRecord[]> {
    const feeds = playableFeeds(await this.deps.catalog.feedsOf([channelId]));
    if (!this.deps.health || feeds.length === 0) return feeds;
    const [states, failover] = await Promise.all([this.deps.health.feedHealthOf(feeds.map((feed) => feed.id)), this.deps.health.failoverOf(channelId)]);
    const byId = new Map(feeds.map((feed) => [feed.id, feed]));
    return playbackOrder(
      feeds.map((feed) => ({ id: feed.id, priority: feed.priority, createdAt: feed.createdAt, health: states.get(feed.id) ?? 'UNKNOWN' })),
      failover?.activeFeedId ?? null,
    ).map((feed) => byId.get(feed.id)!);
  }

  forget(): void {
    this.deps.cache.deleteByPrefix(OPERATOR_CACHE_PREFIX);
  }

  // ---------------------------------------------------------------------------------------------

  /** Channels with a playable feed, their grants and categories — shared by every viewer for a minute. */
  private snapshot(): Promise<CatalogSnapshot> {
    return this.deps.cache.wrap(`${OPERATOR_CACHE_PREFIX}snapshot`, SNAPSHOT_TTL_MS, async () => {
      const channels = await this.deps.catalog.activeChannelsWithFeeds();
      const ids = channels.map((channel) => channel.id);
      const [grants, categories, feeds] = await Promise.all([this.deps.catalog.grantsOf(ids), this.deps.catalog.listCategories(), this.deps.catalog.feedsOf(ids)]);
      const byChannel = new Map<string, StoredGrant[]>();
      for (const grant of grants) byChannel.set(grant.channelId, [...(byChannel.get(grant.channelId) ?? []), grant]);
      const archiveDays = new Map<string, number>();
      for (const feed of playableFeeds(feeds)) archiveDays.set(feed.channelId, Math.max(archiveDays.get(feed.channelId) ?? 0, feed.archiveDays));
      return { channels, grants: byChannel, categories: new Map(categories.map((category) => [category.id, category])), archiveDays };
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

  /** Locked by the profile's parental rules (`operator|<channel id>` or `operator|<category name>`). */
  private lockedByRules(viewer: Viewer, snapshot: CatalogSnapshot, channel: MasterChannelRecord): boolean {
    if (viewer.lockedChannels.has(lockKey(OPERATOR_LOCK_SOURCE, channel.id))) return true;
    const category = channel.categoryId ? snapshot.categories.get(channel.categoryId)?.name : undefined;
    return !!category && viewer.lockedGroups.has(lockKey(OPERATOR_LOCK_SOURCE, category));
  }

  /** Needs the PIN now (never for kids: there locked channels do not exist). */
  private parentalLocked(viewer: Viewer, snapshot: CatalogSnapshot, channel: MasterChannelRecord): boolean {
    return !viewer.unlocked && this.lockedByRules(viewer, snapshot, channel);
  }

  /** Not shown at all: adult when hidden, and for kids anything locked. */
  private concealed(viewer: Viewer, snapshot: CatalogSnapshot, channel: MasterChannelRecord): boolean {
    return (this.hidesAdult(viewer) && this.isAdult(snapshot, channel)) || (viewer.kids && this.lockedByRules(viewer, snapshot, channel));
  }

  private isAdult(snapshot: CatalogSnapshot, channel: MasterChannelRecord): boolean {
    const category = channel.categoryId ? snapshot.categories.get(channel.categoryId) : undefined;
    return category?.slug === 'adult';
  }

  private availableArchive(snapshot: CatalogSnapshot, channelId: string, query: RightsQuery): number {
    return Math.min(snapshot.archiveDays.get(channelId) ?? 0, catchupDaysFor(snapshot.grants.get(channelId) ?? [], query));
  }

  private toChannelDto(snapshot: CatalogSnapshot, channel: MasterChannelRecord, number: number | null, favorite: boolean, query: RightsQuery): OperatorChannelDto {
    return {
      id: channel.id,
      number,
      name: channel.name,
      logo: this.artwork.url(channel.logo),
      category: channel.categoryId ? (snapshot.categories.get(channel.categoryId)?.name ?? null) : null,
      languages: channel.languages,
      favorite,
      locked: false,
      packages: [],
      catchupDays: this.availableArchive(snapshot, channel.id, query),
      parentalLock: false,
    };
  }
}

function toLineupDto(lineup: LineupRecord): OperatorLineupDto {
  return { slug: lineup.slug, name: lineup.name, country: lineup.country };
}

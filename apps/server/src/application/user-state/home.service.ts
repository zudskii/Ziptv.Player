import type { HomeDto, RecentlyAddedItemDto } from '@ziptv/contracts';

import { directArtwork, type ArtworkUrls } from '../catalog/artwork.js';
import { toMovieDto, toSeriesDto } from '../catalog/catalog-mapper.js';
import type { LiveCatalogService } from '../catalog/live.service.js';
import type { EpgService } from '../epg/epg.service.js';
import type { Viewer } from '../identity/viewer.js';
import type { Cache } from '../ports/cache.js';
import type { CatalogRepository } from '../ports/catalog-repository.js';
import type { Logger } from '../ports/logger.js';
import type { SourceRepository } from '../ports/source-repository.js';
import type { SourceService } from '../sources/source.service.js';
import { catalogVersion } from '../sources/source-mapper.js';
import { homeCachePrefix, homeEpoch } from './cache-keys.js';
import type { MyListService } from './my-list.service.js';
import type { WatchStateService } from './watch-state.service.js';

const RAIL = 12;
const HOME_TTL_MS = 20_000;
const SPORTS = /sport|football|soccer|futbol|nba|nfl|nhl|tennis|ufc|boxing|racing|formula|\bf1\b|golf|cricket|rugby|спорт|სპორტ|fútbol|calcio/i;

/**
 * GET /home — every rail in one response. Rails are computed independently: one failing rail
 * (a guide being rewritten, a slow query) leaves it empty instead of failing the page, and
 * `sources` tells the client why rails may be empty (still syncing / failed).
 */
export class HomeService {
  constructor(
    private readonly deps: {
      sources: SourceRepository;
      sourceService: Pick<SourceService, 'list'>;
      catalog: CatalogRepository;
      live: Pick<LiveCatalogService, 'isLocked'>;
      epg: Pick<EpgService, 'liveNow'>;
      myList: Pick<MyListService, 'list'>;
      watch: Pick<WatchStateService, 'continueWatching' | 'recentlyWatched'>;
      cache: Cache;
      logger: Logger;
      artwork?: ArtworkUrls;
    },
  ) {}

  async home(viewer: Viewer): Promise<HomeDto> {
    const owned = await this.deps.sources.listByOwner(viewer.userId);
    const versions = owned.map((source) => `${source.id}:${catalogVersion(source)}:${source.sync.status}`).join(',');
    const key = `${homeCachePrefix(viewer.profileId)}${homeEpoch(this.deps.cache, viewer.profileId)}:${viewer.restrictionsVersion}:${versions}`;
    return this.deps.cache.wrap(key, HOME_TTL_MS, () => this.build(viewer, owned));
  }

  private async build(viewer: Viewer, owned: Awaited<ReturnType<SourceRepository['listByOwner']>>): Promise<HomeDto> {
    const artwork = this.deps.artwork ?? directArtwork;
    const usable = owned.filter((source) => source.revision > 0);
    const refs = usable.map((source) => ({ sourceId: source.id, revision: source.revision }));
    const hideAdult = viewer.kids || viewer.hideAdult;
    const locked = (sourceId: string, item: { key: string; groups: readonly string[] }) => this.deps.live.isLocked(viewer, sourceId, item);

    const [sources, continueWatching, favorites, recentlyWatched] = await Promise.all([
      this.rail('sources', () => this.deps.sourceService.list(viewer.userId)),
      this.rail('continueWatching', () => this.deps.watch.continueWatching(viewer, RAIL)),
      this.rail('favorites', async () => (await this.deps.myList.list(viewer, 60)).items.filter((item) => item.available).slice(0, RAIL)),
      this.rail('recentlyWatched', () => this.deps.watch.recentlyWatched(viewer, RAIL)),
    ]);
    // Favourite and recently watched channels lead "Live Now".
    const preferred = [
      ...favorites.filter((item) => item.type === 'channel').map((item) => ({ sourceId: item.sourceId, key: item.key })),
      ...recentlyWatched.filter((item) => item.contentType === 'channel').map((item) => ({ sourceId: item.sourceId, key: item.key })),
    ];
    const [liveNow, sportsLive, movies, series, recentlyAdded] = await Promise.all([
      this.rail('liveNow', () => this.deps.epg.liveNow(viewer, usable, { preferred, limit: RAIL })),
      this.rail('sportsLive', () =>
        this.deps.epg.liveNow(viewer, usable, {
          preferred,
          limit: RAIL,
          match: (channel, now) => channel.groups.some((group) => SPORTS.test(group)) || SPORTS.test(channel.name) || now.categories.some((category) => SPORTS.test(category)),
        }),
      ),
      this.rail('movies', async () => (await this.deps.catalog.latestMovies(refs, RAIL, hideAdult)).map((movie) => toMovieDto(movie.sourceId, movie, locked(movie.sourceId, movie), artwork))),
      this.rail('series', async () => (await this.deps.catalog.latestSeries(refs, RAIL, hideAdult)).map((item) => toSeriesDto(item.sourceId, item, locked(item.sourceId, item), artwork))),
      this.rail('recentlyAdded', async () =>
        (await this.deps.catalog.recentlyAdded(refs, RAIL, hideAdult))
          .filter((row) => !(viewer.kids && locked(row.sourceId, row)))
          .map((row): RecentlyAddedItemDto => ({ type: row.type, sourceId: row.sourceId, key: row.key, title: row.name, image: artwork.url(row.image), addedAt: row.addedAt.toISOString() })),
      ),
    ]);
    return { continueWatching, liveNow, favorites, recentlyWatched, sportsLive, movies, series, recentlyAdded, sources };
  }

  private async rail<T>(name: string, load: () => Promise<T[]>): Promise<T[]> {
    try {
      return await load();
    } catch (error) {
      this.deps.logger.warn({ err: error, rail: name }, 'Home rail failed');
      return [];
    }
  }
}

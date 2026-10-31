import type {
  EpisodeDto,
  MovieDetailsDto,
  MovieDto,
  MoviePageDto,
  ProgressStateDto,
  SeasonDto,
  SeriesDetailsDto,
  SeriesDto,
  SeriesPageDto,
  VodOverviewDto,
  VodRailDto,
  VodSort,
} from '@ziptv/contracts';

import { remainingSecs } from '../../domain/viewer/progress.js';
import { AppError } from '../errors.js';
import { isHiddenForViewer, type Viewer } from '../identity/viewer.js';
import type { CatalogRepository, MovieSummary, SeriesSummary, SourceRevisionRef, StoredEpisode, VodListQuery } from '../ports/catalog-repository.js';
import type { Cache } from '../ports/cache.js';
import type { SourceRecord } from '../ports/source-repository.js';
import { catalogVersion } from '../sources/source-mapper.js';
import { sourceCachePrefix } from '../sources/source-sync.pipeline.js';
import type { ListRepository, ProgressRecord, ProgressRepository } from '../ports/user-state-repository.js';
import { directArtwork, type ArtworkUrls } from './artwork.js';
import { toMovieDto, toSeriesDto } from './catalog-mapper.js';
import type { LiveCatalogService } from './live.service.js';
import type { SeriesEpisodes } from './series-episodes.js';

const MAX_PAGE = 100;
const RAIL = 20;
const CATEGORY_RAILS = 6;
const OVERVIEW_TTL_MS = 5 * 60_000;

type VodType = 'movies' | 'series';

/**
 * Movies & Series: per-source overview (rails + categories), paged lists by category and sort,
 * and details with the profile's My List / progress state. Xtream series load their episodes on
 * first open (SeriesEpisodes).
 */
export class VodCatalogService {
  constructor(
    private readonly deps: {
      live: Pick<LiveCatalogService, 'requireSource' | 'isLocked'>;
      catalog: CatalogRepository;
      episodes: Pick<SeriesEpisodes, 'list'>;
      list?: Pick<ListRepository, 'keys'>;
      progress?: Pick<ProgressRepository, 'listForSeries' | 'listForMovies'>;
      cache?: Cache;
      artwork?: ArtworkUrls;
    },
  ) {}

  private get artwork(): ArtworkUrls {
    return this.deps.artwork ?? directArtwork;
  }

  async movieOverview(viewer: Viewer, sourceId: string): Promise<VodOverviewDto<MovieDto>> {
    return this.overview(viewer, sourceId, 'movies', (source, query) => this.moviePage(viewer, source, query));
  }

  async seriesOverview(viewer: Viewer, sourceId: string): Promise<VodOverviewDto<SeriesDto>> {
    return this.overview(viewer, sourceId, 'series', (source, query) => this.seriesPage(viewer, source, query));
  }

  async movies(viewer: Viewer, sourceId: string, query: { category?: string | undefined; sort: VodSort; cursor?: string | undefined; limit: number }): Promise<MoviePageDto> {
    const source = await this.requireCatalog(viewer, sourceId);
    return this.moviePage(viewer, source, this.listQuery(viewer, query));
  }

  async series(viewer: Viewer, sourceId: string, query: { category?: string | undefined; sort: VodSort; cursor?: string | undefined; limit: number }): Promise<SeriesPageDto> {
    const source = await this.requireCatalog(viewer, sourceId);
    return this.seriesPage(viewer, source, this.listQuery(viewer, query));
  }

  async movieDetails(viewer: Viewer, sourceId: string, key: string): Promise<MovieDetailsDto> {
    const source = await this.requireCatalog(viewer, sourceId);
    const pin = pinOf(source);
    const movie = await this.deps.catalog.findMovie(pin, key);
    if (!movie || isHiddenForViewer(viewer, movie)) throw AppError.notFound('Movie');
    const [inList, progress] = await Promise.all([
      this.deps.list ? this.deps.list.keys(viewer.profileId, source.id, 'movie') : Promise.resolve(new Set<string>()),
      this.deps.progress ? this.deps.progress.listForMovies(viewer.profileId, source.id, [key]) : Promise.resolve([]),
    ]);
    return {
      ...toMovieDto(source.id, movie, this.deps.live.isLocked(viewer, source.id, movie), this.artwork),
      plot: movie.plot,
      cast: [],
      director: null,
      backdrop: null,
      releaseDate: null,
      trailerUrl: null,
      inMyList: inList.has(key),
      progress: progress[0] ? toProgressState(progress[0]) : null,
    };
  }

  async seriesDetails(viewer: Viewer, sourceId: string, seriesKey: string): Promise<SeriesDetailsDto> {
    const source = await this.requireCatalog(viewer, sourceId);
    const series = await this.deps.catalog.findSeries(pinOf(source), seriesKey);
    if (!series || isHiddenForViewer(viewer, series)) throw AppError.notFound('Series');
    const [episodes, inList, progress] = await Promise.all([
      this.deps.episodes.list(source, series),
      this.deps.list ? this.deps.list.keys(viewer.profileId, source.id, 'series') : Promise.resolve(new Set<string>()),
      this.deps.progress ? this.deps.progress.listForSeries(viewer.profileId, source.id, series.key) : Promise.resolve([]),
    ]);
    const progressByKey = new Map(progress.map((record) => [record.key, record]));
    return {
      ...toSeriesDto(source.id, series, this.deps.live.isLocked(viewer, source.id, series), this.artwork),
      plot: series.plot,
      cast: [],
      director: null,
      backdrop: null,
      seasons: toSeasons(episodes, this.artwork, progressByKey),
      inMyList: inList.has(series.key),
      resume: resumePoint(episodes, progress),
    };
  }

  // ---------------------------------------------------------------------------------------------

  private async overview<T>(
    viewer: Viewer,
    sourceId: string,
    type: VodType,
    page: (source: SourceRecord, query: VodListQuery) => Promise<{ items: T[] }>,
  ): Promise<VodOverviewDto<T>> {
    const source = await this.requireCatalog(viewer, sourceId);
    // The same for every viewer with the same restrictions until the next sync (key = catalog version).
    const key = `${sourceCachePrefix(source.id)}vod-overview:${type}:${catalogVersion(source)}:${viewer.restrictionsVersion}:${hidesAdult(viewer)}`;
    if (!this.deps.cache) return this.buildOverview(source, viewer, type, page);
    return this.deps.cache.wrap(key, OVERVIEW_TTL_MS, () => this.buildOverview(source, viewer, type, page));
  }

  private async buildOverview<T>(
    source: SourceRecord,
    viewer: Viewer,
    type: VodType,
    page: (source: SourceRecord, query: VodListQuery) => Promise<{ items: T[] }>,
  ): Promise<VodOverviewDto<T>> {
    const hideAdult = hidesAdult(viewer);
    const categories = await this.deps.catalog.vodCategories(pinOf(source), type, hideAdult);
    const rail = async (id: string, title: string, category: string | null, sort: VodSort): Promise<VodRailDto<T>> => ({
      id,
      title,
      category,
      items: (await page(source, { sort, offset: 0, limit: RAIL, hideAdult, skipTotal: true, ...(category ? { category } : {}) })).items,
    });
    const rails = await Promise.all([
      rail('recent', 'Recently added', null, 'recent'),
      rail('top', 'Top rated', null, 'rating'),
      ...categories.slice(0, CATEGORY_RAILS).map((category, index) => rail(`category-${index}`, category.name, category.name, 'recent')),
    ]);
    return { sourceId: source.id, categories, rails: rails.filter((item) => item.items.length > 0) };
  }

  private async moviePage(viewer: Viewer, source: SourceRecord, query: VodListQuery): Promise<MoviePageDto> {
    const { items, total } = await this.deps.catalog.listMovies(pinOf(source), query);
    return this.page(items, total, query, (movie: MovieSummary) => toMovieDto(source.id, movie, this.deps.live.isLocked(viewer, source.id, movie), this.artwork));
  }

  private async seriesPage(viewer: Viewer, source: SourceRecord, query: VodListQuery): Promise<SeriesPageDto> {
    const { items, total } = await this.deps.catalog.listSeries(pinOf(source), query);
    return this.page(items, total, query, (series: SeriesSummary) => toSeriesDto(source.id, series, this.deps.live.isLocked(viewer, source.id, series), this.artwork));
  }

  private page<S, T>(items: S[], total: number, query: VodListQuery, map: (item: S) => T): { items: T[]; nextCursor: string | null; total: number } {
    const next = query.offset + items.length;
    return { items: items.map(map), nextCursor: next < total && items.length > 0 ? String(next) : null, total };
  }

  private listQuery(viewer: Viewer, query: { category?: string | undefined; sort: VodSort; cursor?: string | undefined; limit: number }): VodListQuery {
    const offset = query.cursor ? Number(query.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw AppError.validation('Invalid cursor.');
    return { sort: query.sort, offset, limit: Math.min(Math.max(query.limit, 1), MAX_PAGE), hideAdult: hidesAdult(viewer), ...(query.category ? { category: query.category } : {}) };
  }

  private async requireCatalog(viewer: Viewer, sourceId: string): Promise<SourceRecord> {
    const source = await this.deps.live.requireSource(viewer, sourceId);
    if (source.revision === 0) throw new AppError('NOT_FOUND', 404, 'This source has not been loaded yet.');
    return source;
  }
}

function pinOf(source: SourceRecord): SourceRevisionRef {
  return { sourceId: source.id, revision: source.revision };
}

function hidesAdult(viewer: Viewer): boolean {
  return viewer.kids || viewer.hideAdult;
}

function toProgressState(record: ProgressRecord): ProgressStateDto {
  return { position: Math.round(record.position), duration: Math.round(record.duration), completed: record.completed, updatedAt: record.updatedAt.toISOString() };
}

export function toSeasons(episodes: readonly StoredEpisode[], artwork: ArtworkUrls, progress: Map<string, ProgressRecord> = new Map()): SeasonDto[] {
  const seasons = new Map<number, EpisodeDto[]>();
  for (const episode of episodes) {
    let list = seasons.get(episode.season);
    if (!list) seasons.set(episode.season, (list = []));
    const saved = progress.get(episode.key);
    list.push({
      key: episode.key,
      season: episode.season,
      episode: episode.episode,
      title: episode.title,
      plot: episode.plot,
      durationSecs: episode.durationSecs,
      still: artwork.url(episode.still),
      airDate: episode.airDate,
      progress: saved ? toProgressState(saved) : null,
    });
  }
  return [...seasons.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, list]) => ({
      number,
      name: number === 0 ? 'Specials' : `Season ${number}`,
      cover: null,
      episodes: list.sort((a, b) => a.episode - b.episode),
    }));
}

/**
 * Where "Play" starts: the most recently watched unfinished episode; after a finished one, the
 * episode that follows it; nothing watched yet → null (the client starts at the first episode).
 */
export function resumePoint(episodes: readonly StoredEpisode[], progress: readonly ProgressRecord[]): SeriesDetailsDto['resume'] {
  const latest = [...progress].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  if (!latest) return null;
  const index = episodes.findIndex((episode) => episode.key === latest.key);
  if (index === -1) return null;
  const target = latest.completed ? episodes[index + 1] : episodes[index];
  if (!target) return null;
  const position = latest.completed ? 0 : Math.round(latest.position);
  const duration = latest.completed ? (target.durationSecs ?? 0) : Math.round(latest.duration);
  return {
    episodeKey: target.key,
    season: target.season,
    episode: target.episode,
    title: target.title,
    position,
    duration,
    remainingSecs: remainingSecs(position, duration),
  };
}

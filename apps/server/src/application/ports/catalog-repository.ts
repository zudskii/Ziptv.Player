import type { EpgLink, EpisodeEntry, LiveChannelEntry, MovieEntry, SeriesEntry } from '../../domain/catalog/model.js';

/** Stored forms: locators are encrypted strings, plus search/match keys computed at sync time. */
export interface StoredLiveChannel extends Omit<LiveChannelEntry, 'locator'> {
  locator: string | null;
  /** `normalizeChannelName(name)` — EPG name matching and "same channel in another source". */
  nameKey: string;
  searchTokens: string[];
}

export interface StoredMovie extends Omit<MovieEntry, 'locator'> {
  locator: string | null;
  searchTokens: string[];
}

export interface StoredSeries extends SeriesEntry {
  searchTokens: string[];
  /** Provider-API sources: when episodes were last fetched on demand (null = not yet). */
  detailsFetchedAt: Date | null;
}

export interface StoredEpisode extends Omit<EpisodeEntry, 'locator'> {
  locator: string | null;
}

export type LiveChannelSummary = Omit<StoredLiveChannel, 'locator' | 'searchTokens' | 'tvgName'>;

/** Reference to a source at a given revision (catalog reads always pin a revision). */
export interface SourceRevisionRef {
  sourceId: string;
  revision: number;
}

export interface LiveLinkTarget {
  key: string;
  name: string;
  nameKey: string;
  tvgId: string | null;
  xtreamEpgId: string | null;
  /** Archive depth: the guide keeps that many days of past programmes for catch-up. */
  catchupDays: number | null;
  epg: EpgLink | null;
}

export interface RevisionData {
  live: StoredLiveChannel[];
  movies: StoredMovie[];
  series: StoredSeries[];
  episodes: StoredEpisode[];
}

export interface AddedAtIndex {
  live: Map<string, Date | null>;
  movies: Map<string, Date | null>;
  series: Map<string, Date | null>;
}

export type VodSortOrder = 'recent' | 'name' | 'rating' | 'year';

export interface VodListQuery {
  category?: string | undefined;
  sort: VodSortOrder;
  offset: number;
  limit: number;
  /** Leave out adult items (kids profiles, "hide adult"). */
  hideAdult: boolean;
  /** Skip counting the matching items (rails need none); total is then -1. */
  skipTotal?: boolean;
}

export type MovieSummary = Omit<StoredMovie, 'locator' | 'searchTokens'>;
export type SeriesSummary = Omit<StoredSeries, 'searchTokens' | 'detailsFetchedAt'>;

export interface CatalogSearchResult {
  live: (LiveChannelSummary & { sourceId: string })[];
  movies: (MovieSummary & { sourceId: string })[];
  series: (SeriesSummary & { sourceId: string })[];
}

export interface RecentlyAddedRow {
  type: 'channel' | 'movie' | 'series';
  sourceId: string;
  key: string;
  name: string;
  image: string | null;
  addedAt: Date;
  groups: string[];
}

export interface CatalogRepository {
  insertRevision(sourceId: string, revision: number, data: RevisionData): Promise<void>;
  deleteRevision(sourceId: string, revision: number): Promise<void>;
  deleteOtherRevisions(sourceId: string, keepRevision: number): Promise<void>;
  deleteSource(sourceId: string): Promise<void>;
  /** key → addedAt of a revision, to carry "first seen" dates into the next one. */
  addedAtIndex(sourceId: string, revision: number): Promise<AddedAtIndex>;

  // --- live -------------------------------------------------------------------------------
  listLive(ref: SourceRevisionRef): Promise<LiveChannelSummary[]>;
  findLive(ref: SourceRevisionRef, key: string): Promise<StoredLiveChannel | null>;
  findLiveMany(ref: SourceRevisionRef, keys: string[]): Promise<LiveChannelSummary[]>;
  /** Channels with the same normalised name in other sources ("Try alternate stream"). */
  findLiveByNameKey(refs: SourceRevisionRef[], nameKey: string, limit: number): Promise<(LiveChannelSummary & { sourceId: string })[]>;
  liveLinkTargets(ref: SourceRevisionRef): Promise<LiveLinkTarget[]>;
  setLiveEpgLinks(ref: SourceRevisionRef, changes: { key: string; epg: EpgLink | null }[]): Promise<void>;

  // --- VOD --------------------------------------------------------------------------------
  findMovie(ref: SourceRevisionRef, key: string): Promise<StoredMovie | null>;
  findSeries(ref: SourceRevisionRef, key: string): Promise<StoredSeries | null>;
  findEpisode(ref: SourceRevisionRef, seriesKey: string, key: string): Promise<StoredEpisode | null>;
  listEpisodes(ref: SourceRevisionRef, seriesKey: string): Promise<StoredEpisode[]>;
  listMovies(ref: SourceRevisionRef, query: VodListQuery): Promise<{ items: MovieSummary[]; total: number }>;
  listSeries(ref: SourceRevisionRef, query: VodListQuery): Promise<{ items: SeriesSummary[]; total: number }>;
  /** Categories in provider order with item counts. */
  vodCategories(ref: SourceRevisionRef, type: 'movies' | 'series', hideAdult: boolean): Promise<{ name: string; count: number }[]>;
  findMoviesMany(ref: SourceRevisionRef, keys: string[]): Promise<MovieSummary[]>;
  findSeriesMany(ref: SourceRevisionRef, keys: string[]): Promise<SeriesSummary[]>;
  /** Newest items (provider date or first-seen date) across sources. */
  recentlyAdded(refs: SourceRevisionRef[], limit: number, hideAdult: boolean): Promise<RecentlyAddedRow[]>;
  /** Newest / best-rated VOD across sources (Home rails). */
  latestMovies(refs: SourceRevisionRef[], limit: number, hideAdult: boolean): Promise<(MovieSummary & { sourceId: string })[]>;
  latestSeries(refs: SourceRevisionRef[], limit: number, hideAdult: boolean): Promise<(SeriesSummary & { sourceId: string })[]>;
  /** Every term must prefix-match a word of the name (trigram-indexed). */
  search(refs: SourceRevisionRef[], terms: string[], limitPerType: number, hideAdult: boolean): Promise<CatalogSearchResult>;
  /**
   * Stores episodes fetched on demand into the pinned revision (idempotent: concurrent fetches
   * of the same series insert the same keys) and stamps `detailsFetchedAt`. False = that
   * revision of the series no longer exists (a sync replaced it meanwhile).
   */
  storeSeriesDetails(ref: SourceRevisionRef, seriesKey: string, details: { episodes: StoredEpisode[]; plot: string | null }, fetchedAt: Date): Promise<boolean>;
}

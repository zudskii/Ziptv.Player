import type { GenreId } from '../../domain/catalog/genres.js';
import type { HiddenContent, MovieSummary, SeriesSummary, SourceRevisionRef, VodSortOrder } from './catalog-repository.js';

/** One source the viewer may browse, with what a kids profile must not see in it. */
export interface VodBrowseScope {
  ref: SourceRevisionRef;
  hidden?: HiddenContent | undefined;
}

export type VodLength = 'short' | 'medium' | 'long';
export type VodWatchState = 'unwatched' | 'started' | 'finished';

export interface VodBrowseFilters {
  /** Subset of the scopes' sources; absent = all of them. */
  sourceIds?: readonly string[] | undefined;
  /** Any of these canonical genres. */
  genres?: readonly GenreId[] | undefined;
  /** A provider category (exact name). */
  category?: string | undefined;
  yearMin?: number | undefined;
  yearMax?: number | undefined;
  ratingMin?: number | undefined;
  /** Movies only: < 90 min, 90–120 min, > 120 min (unknown durations never match). */
  length?: VodLength | undefined;
  addedSince?: Date | undefined;
  /** For the viewing profile: never opened / started / watched to the end (movies only). */
  watch?: VodWatchState | undefined;
  /** Every term must prefix-match a word of the name. */
  terms?: readonly string[] | undefined;
}

/** Keyset position: the last item's sort value and tiebreakers. */
export interface VodCursor {
  value: number | string;
  sourceId: string;
  position: number;
}

export interface VodBrowseQuery {
  scopes: readonly VodBrowseScope[];
  filters: VodBrowseFilters;
  hideAdult: boolean;
  profileId: string;
  sort: VodSortOrder;
  after: VodCursor | null;
  limit: number;
  /** Also count the facets (first page). */
  facets: boolean;
  now: Date;
}

/** For each filter, how many items each choice would give with all the *other* filters applied. */
export interface VodFacets {
  genres: { id: GenreId; count: number }[];
  decades: { decade: number; count: number }[];
  ratings: { min: number; count: number }[];
  lengths: { id: VodLength; count: number }[];
  added: { days: number; count: number }[];
  sources: { sourceId: string; count: number }[];
}

export interface VodBrowsePage<T> {
  items: (T & { sourceId: string })[];
  total: number;
  next: VodCursor | null;
  facets?: VodFacets;
}

export interface VodBrowseRepository {
  browseMovies(query: VodBrowseQuery): Promise<VodBrowsePage<MovieSummary>>;
  browseSeries(query: VodBrowseQuery): Promise<VodBrowsePage<SeriesSummary>>;
}

export const ADDED_WINDOWS_DAYS = [7, 30, 90, 365] as const;
export const RATING_STEPS = [5, 6, 7, 8] as const;

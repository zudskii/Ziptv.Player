import type { GenreId, VodBrowsePageDto, VodLength, VodSort, VodWatchFilter } from '@ziptv/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api-client';
import type { VodItem, VodKind } from './api';

export const GENRES: readonly GenreId[] = [
  'action',
  'adventure',
  'animation',
  'biography',
  'comedy',
  'crime',
  'documentary',
  'drama',
  'family',
  'fantasy',
  'history',
  'horror',
  'kids',
  'music',
  'mystery',
  'reality',
  'romance',
  'scifi',
  'sport',
  'thriller',
  'war',
  'western',
];
export const RATINGS = [5, 6, 7, 8] as const;
export const ADDED_DAYS = [7, 30, 90, 365] as const;
export const LENGTHS: readonly VodLength[] = ['short', 'medium', 'long'];
export const WATCH: readonly VodWatchFilter[] = ['unwatched', 'started', 'finished'];

/** Everything the filter panel can narrow by. Lives in the URL, so a filtered list can be shared and survives reloads. */
export interface VodFilters {
  genres: GenreId[];
  decade: number | null;
  rating: number | null;
  length: VodLength | null;
  added: number | null;
  watch: VodWatchFilter | null;
  sources: string[];
  q: string;
}

export const NO_FILTERS: VodFilters = { genres: [], decade: null, rating: null, length: null, added: null, watch: null, sources: [], q: '' };

const list = (value: string | null) => (value ? value.split(',').filter(Boolean) : []);
const int = (value: string | null) => (value && /^\d+$/.test(value) ? Number(value) : null);

/** URL → filters; anything unknown or malformed is dropped (old links keep working). */
export function readFilters(params: URLSearchParams, kind: VodKind): VodFilters {
  const decade = int(params.get('decade'));
  const rating = int(params.get('rating'));
  const added = int(params.get('added'));
  const length = params.get('length') as VodLength | null;
  const watch = params.get('watch') as VodWatchFilter | null;
  return {
    genres: list(params.get('genres')).filter((id): id is GenreId => (GENRES as readonly string[]).includes(id)),
    decade: decade !== null && decade >= 1880 && decade <= 2100 && decade % 10 === 0 ? decade : null,
    rating: rating !== null && (RATINGS as readonly number[]).includes(rating) ? rating : null,
    length: kind === 'movies' && length && LENGTHS.includes(length) ? length : null,
    added: added !== null && (ADDED_DAYS as readonly number[]).includes(added) ? added : null,
    watch: watch && WATCH.includes(watch) && (kind === 'movies' || watch !== 'finished') ? watch : null,
    sources: list(params.get('sources')).filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
    q: (params.get('q') ?? '').slice(0, 100),
  };
}

/** Filters → URL, keeping the other parameters (sort, category) as they are. */
export function writeFilters(params: URLSearchParams, filters: VodFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, value: string | number | null) => (value === null || value === '' ? next.delete(key) : next.set(key, String(value)));
  set('genres', filters.genres.join(',') || null);
  set('decade', filters.decade);
  set('rating', filters.rating);
  set('length', filters.length);
  set('added', filters.added);
  set('watch', filters.watch);
  set('sources', filters.sources.join(',') || null);
  set('q', filters.q.trim() || null);
  return next;
}

export function activeFilterCount(filters: VodFilters): number {
  return filters.genres.length + filters.sources.length + [filters.decade, filters.rating, filters.length, filters.added, filters.watch].filter((value) => value !== null).length + (filters.q.trim() ? 1 : 0);
}

/**
 * The filtered list across the whole library (GET /browse). The first page brings the facet counts
 * the panel shows next to each choice.
 */
export function useVodBrowse(kind: VodKind, filters: VodFilters, sort: VodSort, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['vod', kind, 'browse', filters, sort],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ sort, limit: '48' });
      if (filters.genres.length) params.set('genres', filters.genres.join(','));
      if (filters.decade !== null) {
        params.set('yearMin', String(filters.decade));
        params.set('yearMax', String(filters.decade + 9));
      }
      if (filters.rating !== null) params.set('ratingMin', String(filters.rating));
      if (filters.length) params.set('length', filters.length);
      if (filters.added !== null) params.set('added', String(filters.added));
      if (filters.watch) params.set('watch', filters.watch);
      if (filters.sources.length) params.set('sources', filters.sources.join(','));
      if (filters.q.trim()) params.set('q', filters.q.trim());
      if (pageParam) params.set('cursor', pageParam);
      else params.set('facets', '1');
      return apiRequest<VodBrowsePageDto<VodItem>>(`/api/v1/browse/${kind}?${params.toString()}`, { signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
}

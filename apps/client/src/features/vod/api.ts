import type { MovieDetailsDto, MovieDto, PageDto, SeriesDetailsDto, SeriesDto, VodOverviewDto, VodSort } from '@ziptv/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api-client';

export type VodKind = 'movies' | 'series';
export type VodItem = MovieDto | SeriesDto;

const base = (sourceId: string, kind: VodKind) => `/api/v1/vod/${sourceId}/${kind}`;

export function useVodOverview(sourceId: string | undefined, kind: VodKind) {
  return useQuery({
    queryKey: ['vod', kind, 'overview', sourceId],
    queryFn: ({ signal }) => apiRequest<VodOverviewDto<VodItem>>(`${base(sourceId!, kind)}/overview`, { signal }),
    enabled: Boolean(sourceId),
    staleTime: 60_000,
  });
}

export function useVodList(sourceId: string | undefined, kind: VodKind, filter: { category: string | null; sort: VodSort }, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['vod', kind, 'list', sourceId, filter.category, filter.sort],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ sort: filter.sort, limit: '48' });
      if (filter.category) params.set('category', filter.category);
      if (pageParam) params.set('cursor', pageParam);
      return apiRequest<PageDto<VodItem>>(`${base(sourceId!, kind)}?${params.toString()}`, { signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(sourceId) && enabled,
    staleTime: 60_000,
  });
}

export function useMovieDetails(sourceId: string | undefined, key: string | undefined) {
  return useQuery({
    queryKey: ['vod', 'movies', 'details', sourceId, key],
    queryFn: ({ signal }) => apiRequest<MovieDetailsDto>(`${base(sourceId!, 'movies')}/${key}`, { signal }),
    enabled: Boolean(sourceId && key),
  });
}

export function useSeriesDetails(sourceId: string | undefined, key: string | undefined) {
  return useQuery({
    queryKey: ['vod', 'series', 'details', sourceId, key],
    queryFn: ({ signal }) => apiRequest<SeriesDetailsDto>(`${base(sourceId!, 'series')}/${key}`, { signal }),
    enabled: Boolean(sourceId && key),
  });
}

export function isMovie(item: VodItem): item is MovieDto {
  return 'poster' in item;
}

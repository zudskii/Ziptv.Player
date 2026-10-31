import type {
  ClearableData,
  HistoryPageDto,
  HomeDto,
  ImportLocalStateDto,
  ImportLocalStateRequest,
  ListItemDto,
  ListItemType,
  ListStateDto,
  ProgressContentType,
  ProgressItemDto,
  SearchResultDto,
  SettingsDto,
  StorageUsageDto,
  UpdateSettingsRequest,
} from '@ziptv/contracts';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useMemo } from 'react';

import { apiRequest } from '../../lib/api-client';

const ME = '/api/v1/me';

export const userStateKeys = {
  home: ['home'] as const,
  list: ['my-list'] as const,
  progress: ['progress'] as const,
  history: ['history'] as const,
  settings: ['settings'] as const,
  storage: ['storage'] as const,
  search: (q: string) => ['search', q] as const,
};

/** Everything that shows personal state (rails, details pages) is refetched after a change. */
function useInvalidatePersonal() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: userStateKeys.home }),
      client.invalidateQueries({ queryKey: userStateKeys.list }),
      client.invalidateQueries({ queryKey: userStateKeys.progress }),
      client.invalidateQueries({ queryKey: userStateKeys.history }),
      client.invalidateQueries({ queryKey: ['vod'] }),
      client.invalidateQueries({ queryKey: userStateKeys.storage }),
    ]);
}

// --- Home & search -----------------------------------------------------------------------------

export function useHome() {
  return useQuery({ queryKey: userStateKeys.home, queryFn: ({ signal }) => apiRequest<HomeDto>('/api/v1/home', { signal }), staleTime: 15_000, refetchInterval: 60_000 });
}

export function useSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: userStateKeys.search(q),
    queryFn: ({ signal }) => apiRequest<SearchResultDto>(`/api/v1/search?q=${encodeURIComponent(q)}`, { signal }),
    enabled: q.length >= 2,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

// --- My List -----------------------------------------------------------------------------------

export function useMyList() {
  return useQuery({ queryKey: userStateKeys.list, queryFn: ({ signal }) => apiRequest<ListStateDto>(`${ME}/list`, { signal }), staleTime: 30_000 });
}

/** Keys of one type in one source that are on My List (cards, channel rows). */
export function useListKeys(sourceId: string | undefined, type: ListItemType): Set<string> {
  const list = useMyList().data;
  // Stable identity while the list is unchanged (used in memo/effect dependencies).
  return useMemo(() => new Set((list?.items ?? []).filter((item) => item.sourceId === sourceId && item.type === type).map((item) => item.key)), [list, sourceId, type]);
}

export function useToggleListItem() {
  const client = useQueryClient();
  const invalidate = useInvalidatePersonal();
  return useMutation({
    mutationFn: ({ item, add }: { item: { type: ListItemType; sourceId: string; key: string }; add: boolean }) =>
      apiRequest<ListItemDto | undefined>(`${ME}/list/${item.type}/${item.sourceId}/${item.key}`, { method: add ? 'PUT' : 'DELETE' }),
    // Optimistic: the star flips immediately.
    onMutate: async ({ item, add }) => {
      await client.cancelQueries({ queryKey: userStateKeys.list });
      const previous = client.getQueryData<ListStateDto>(userStateKeys.list);
      if (previous) {
        const rest = previous.items.filter((entry) => !(entry.type === item.type && entry.sourceId === item.sourceId && entry.key === item.key));
        const placeholder: ListItemDto = { ...item, title: '', image: null, subtitle: null, addedAt: new Date().toISOString(), available: true };
        client.setQueryData<ListStateDto>(userStateKeys.list, { items: add ? [placeholder, ...rest] : rest });
      }
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) client.setQueryData(userStateKeys.list, context.previous);
    },
    onSettled: () => invalidate(),
  });
}

// --- Continue watching / history ------------------------------------------------------------------

export function useContinueWatching() {
  return useQuery({ queryKey: userStateKeys.progress, queryFn: ({ signal }) => apiRequest<ProgressItemDto[]>(`${ME}/progress`, { signal }) });
}

export function useRemoveProgress() {
  const invalidate = useInvalidatePersonal();
  return useMutation({
    mutationFn: (item: { contentType: ProgressContentType; sourceId: string; key: string; seriesKey: string | null }) =>
      apiRequest<void>(`${ME}/progress/${item.contentType}/${item.sourceId}/${item.key}${item.seriesKey ? `?seriesKey=${item.seriesKey}` : ''}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(),
  });
}

export function useHistory() {
  return useInfiniteQuery({
    queryKey: userStateKeys.history,
    queryFn: ({ pageParam, signal }) => apiRequest<HistoryPageDto>(`${ME}/history?limit=40${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`, { signal }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useRemoveHistory() {
  const invalidate = useInvalidatePersonal();
  return useMutation({ mutationFn: (id: string) => apiRequest<void>(`${ME}/history/${id}`, { method: 'DELETE' }), onSuccess: () => invalidate() });
}

export function useClearData() {
  const invalidate = useInvalidatePersonal();
  return useMutation({ mutationFn: (kind: ClearableData) => apiRequest<void>(`${ME}/data/${kind}`, { method: 'DELETE' }), onSuccess: () => invalidate() });
}

// --- Settings / storage / import ------------------------------------------------------------------

export function useSettings() {
  return useQuery({ queryKey: userStateKeys.settings, queryFn: ({ signal }) => apiRequest<SettingsDto>(`${ME}/settings`, { signal }), staleTime: 5 * 60_000 });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateSettingsRequest) => apiRequest<SettingsDto>(`${ME}/settings`, { method: 'PATCH', body: patch }),
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: userStateKeys.settings });
      const previous = client.getQueryData<SettingsDto>(userStateKeys.settings);
      if (previous) {
        const next = structuredClone(previous) as unknown as Record<string, Record<string, unknown>>;
        for (const [section, fields] of Object.entries(patch)) Object.assign(next[section] ?? {}, fields);
        client.setQueryData(userStateKeys.settings, next as unknown as SettingsDto);
      }
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) client.setQueryData(userStateKeys.settings, context.previous);
    },
    onSuccess: (settings) => {
      client.setQueryData(userStateKeys.settings, settings);
      void client.invalidateQueries({ queryKey: userStateKeys.home });
    },
  });
}

export function useStorageUsage() {
  return useQuery({ queryKey: userStateKeys.storage, queryFn: ({ signal }) => apiRequest<StorageUsageDto>(`${ME}/storage`, { signal }) });
}

export function importLocalState(input: ImportLocalStateRequest): Promise<ImportLocalStateDto> {
  return apiRequest<ImportLocalStateDto>(`${ME}/import-local`, { method: 'POST', body: input });
}

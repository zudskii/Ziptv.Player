import type { AddSourceRequest, ChannelListDto, SourceDto, UpdateSourceRequest } from '@ziptv/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { apiRequest } from '../../lib/api-client';

const BASE = '/api/v1/sources';

export const sourcesApi = {
  list: (signal?: AbortSignal) => apiRequest<SourceDto[]>(BASE, { signal }),
  get: (id: string, signal?: AbortSignal) => apiRequest<SourceDto>(`${BASE}/${id}`, { signal }),
  add: (input: AddSourceRequest) => apiRequest<SourceDto>(BASE, { method: 'POST', body: input }),
  upload: (input: { file: File; name?: string }) => {
    const form = new FormData();
    if (input.name) form.append('name', input.name);
    form.append('file', input.file);
    return apiRequest<SourceDto>(`${BASE}/upload`, { method: 'POST', body: form });
  },
  replaceFile: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiRequest<SourceDto>(`${BASE}/${id}/file`, { method: 'POST', body: form });
  },
  update: (id: string, patch: UpdateSourceRequest) => apiRequest<SourceDto>(`${BASE}/${id}`, { method: 'PATCH', body: patch }),
  sync: (id: string) => apiRequest<SourceDto>(`${BASE}/${id}/sync`, { method: 'POST' }),
  remove: (id: string) => apiRequest<void>(`${BASE}/${id}`, { method: 'DELETE' }),
  channels: (id: string, signal?: AbortSignal) => apiRequest<ChannelListDto>(`/api/v1/live/${id}/channels`, { signal }),
};

export const sourceKeys = {
  all: ['sources'] as const,
  channels: (sourceId: string, catalogVersion: string) => ['channels', sourceId, catalogVersion] as const,
};

export function isSyncing(source: Pick<SourceDto, 'sync'>): boolean {
  return source.sync.status === 'queued' || source.sync.status === 'running';
}

/**
 * The user's sources. Polls quickly while a sync is running (onboarding progress, "Sync now")
 * and slowly otherwise, so background syncs show up without a reload.
 */
export function useSources() {
  return useQuery({
    queryKey: sourceKeys.all,
    queryFn: ({ signal }) => sourcesApi.list(signal),
    staleTime: 10_000,
    refetchInterval: (query) => (query.state.data?.some(isSyncing) ? 1_500 : 60_000),
  });
}

export function useSource(id: string | undefined) {
  const sources = useSources();
  return { ...sources, data: id ? sources.data?.find((source) => source.id === id) : undefined };
}

/** Keyed by catalogVersion: a re-synced source or changed guide links refetch; otherwise never. */
export function useChannelList(source: SourceDto | undefined) {
  return useQuery({
    queryKey: source ? sourceKeys.channels(source.id, source.catalogVersion) : ['channels', 'none'],
    queryFn: ({ signal }) => sourcesApi.channels(source!.id, signal),
    enabled: Boolean(source && source.revision > 0),
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    // While a new version loads, keep showing the previous list of the same source.
    placeholderData: (previous) => (previous && previous.sourceId === source?.id ? previous : undefined),
  });
}

function useUpsertSource() {
  const queryClient = useQueryClient();
  return (source: SourceDto) => {
    queryClient.setQueryData<SourceDto[]>(sourceKeys.all, (current = []) => {
      const exists = current.some((item) => item.id === source.id);
      return exists ? current.map((item) => (item.id === source.id ? source : item)) : [...current, source];
    });
  };
}

export function useAddSource() {
  const upsert = useUpsertSource();
  return useMutation({ mutationFn: sourcesApi.add, onSuccess: upsert });
}

export function useUploadSource() {
  const upsert = useUpsertSource();
  return useMutation({ mutationFn: sourcesApi.upload, onSuccess: upsert });
}

export function useReplaceSourceFile() {
  const upsert = useUpsertSource();
  return useMutation({ mutationFn: (input: { id: string; file: File }) => sourcesApi.replaceFile(input.id, input.file), onSuccess: upsert });
}

export function useUpdateSource() {
  const upsert = useUpsertSource();
  return useMutation({ mutationFn: (input: { id: string; patch: UpdateSourceRequest }) => sourcesApi.update(input.id, input.patch), onSuccess: upsert });
}

export function useSyncSource() {
  const upsert = useUpsertSource();
  return useMutation({ mutationFn: sourcesApi.sync, onSuccess: upsert });
}

export function useDeleteSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: sourcesApi.remove,
    onSuccess: (_result, id) => {
      queryClient.setQueryData<SourceDto[]>(sourceKeys.all, (current = []) => current.filter((item) => item.id !== id));
      queryClient.removeQueries({ queryKey: ['channels', id] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    },
  });
}

/** Refreshes everything derived from sources once a background sync finishes. */
export function useRefreshOnSyncCompletion(sources: SourceDto[] | undefined): void {
  const queryClient = useQueryClient();
  const signature = (sources ?? []).map((source) => `${source.id}:${source.catalogVersion}`).join('|');
  useQueryKeyEffect(signature, () => {
    void queryClient.invalidateQueries({ queryKey: ['home'] });
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  });
}


function useQueryKeyEffect(signature: string, effect: () => void): void {
  const previous = useRef(signature);
  const latest = useRef(effect);
  useEffect(() => {
    latest.current = effect;
  });
  useEffect(() => {
    if (previous.current === signature) return;
    previous.current = signature;
    latest.current();
  }, [signature]);
}

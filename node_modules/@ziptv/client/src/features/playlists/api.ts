import type { ChannelListDto, ImportPlaylistRequest, PlaylistDto } from '@ziptv/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api-client';
import { useLibraryStore } from '../library/library-store';

const BASE = '/api/v1/playlists';

export const playlistsApi = {
  list: (signal?: AbortSignal) => apiRequest<PlaylistDto[]>(BASE, { signal }),
  upload: (input: { file: File; name?: string }) => {
    const form = new FormData();
    if (input.name) form.append('name', input.name);
    form.append('file', input.file);
    return apiRequest<PlaylistDto>(`${BASE}/upload`, { method: 'POST', body: form });
  },
  importUrl: (input: ImportPlaylistRequest) => apiRequest<PlaylistDto>(`${BASE}/import`, { method: 'POST', body: input }),
  refresh: (id: string) => apiRequest<PlaylistDto>(`${BASE}/${id}/refresh`, { method: 'POST' }),
  rename: (id: string, name: string) => apiRequest<PlaylistDto>(`${BASE}/${id}`, { method: 'PATCH', body: { name } }),
  remove: (id: string) => apiRequest<void>(`${BASE}/${id}`, { method: 'DELETE' }),
  channels: (id: string, signal?: AbortSignal) => apiRequest<ChannelListDto>(`${BASE}/${id}/channels`, { signal }),
};

export const queryKeys = {
  playlists: ['playlists'] as const,
  channels: (playlistId: string, revision: number) => ['channels', playlistId, revision] as const,
};

export function usePlaylists() {
  return useQuery({
    queryKey: queryKeys.playlists,
    queryFn: ({ signal }) => playlistsApi.list(signal),
    staleTime: 30_000,
  });
}

/** Keyed by revision: a refreshed playlist is refetched, an unchanged one never is. */
export function useChannelList(playlist: PlaylistDto | undefined) {
  return useQuery({
    queryKey: playlist ? queryKeys.channels(playlist.id, playlist.revision) : ['channels', 'none'],
    queryFn: ({ signal }) => playlistsApi.channels(playlist!.id, signal),
    enabled: Boolean(playlist),
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

function useUpsertPlaylist() {
  const queryClient = useQueryClient();
  return (playlist: PlaylistDto) => {
    queryClient.setQueryData<PlaylistDto[]>(queryKeys.playlists, (current = []) => {
      const exists = current.some((item) => item.id === playlist.id);
      return exists ? current.map((item) => (item.id === playlist.id ? playlist : item)) : [...current, playlist];
    });
  };
}

export function useUploadPlaylist() {
  const upsert = useUpsertPlaylist();
  return useMutation({ mutationFn: playlistsApi.upload, onSuccess: upsert });
}

export function useImportPlaylist() {
  const upsert = useUpsertPlaylist();
  return useMutation({ mutationFn: playlistsApi.importUrl, onSuccess: upsert });
}

export function useRefreshPlaylist() {
  const upsert = useUpsertPlaylist();
  return useMutation({ mutationFn: playlistsApi.refresh, onSuccess: upsert });
}

export function useRenamePlaylist() {
  const upsert = useUpsertPlaylist();
  return useMutation({ mutationFn: (input: { id: string; name: string }) => playlistsApi.rename(input.id, input.name), onSuccess: upsert });
}

export function useDeletePlaylist() {
  const queryClient = useQueryClient();
  const forgetPlaylist = useLibraryStore((state) => state.forgetPlaylist);
  return useMutation({
    mutationFn: playlistsApi.remove,
    onSuccess: (_result, id) => {
      queryClient.setQueryData<PlaylistDto[]>(queryKeys.playlists, (current = []) => current.filter((item) => item.id !== id));
      queryClient.removeQueries({ queryKey: ['channels', id] });
      forgetPlaylist(id);
    },
  });
}

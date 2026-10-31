import type { AddFromSourceRequest, MoveEntriesRequest, PlaylistDto, PlaylistEntryDto, PlaylistEntryPageDto, RenumberRequest, TransferEntriesRequest, UpdateEntryRequest } from '@ziptv/contracts';
import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { playlistsApi } from './client';
import { filterKey, MAX_PAGE_SIZE, type EntryFilter } from './entry-filter';
import { locate, PAGE_SIZE, pagesForRange } from './paging';
import { chunk, MAX_IDS_PER_REQUEST } from './selection';

export const playlistKeys = {
  all: ['playlists'] as const,
  one: (id: string) => ['playlist', id] as const,
  entries: (id: string) => ['playlist-entries', id] as const,
  page: (id: string, filter: EntryFilter, page: number) => ['playlist-entries', id, filterKey(filter), page] as const,
};

export function usePlaylists(enabled = true) {
  return useQuery({ queryKey: playlistKeys.all, queryFn: ({ signal }) => playlistsApi.list(signal), enabled, staleTime: 10_000 });
}

export function usePlaylist(id: string | undefined) {
  return useQuery({ queryKey: playlistKeys.one(id ?? ''), queryFn: ({ signal }) => playlistsApi.get(id!, signal), enabled: Boolean(id), staleTime: 5_000 });
}

/**
 * Entries of a playlist as a sparse list: `entryAt(i)` is undefined while its page loads. Pass the
 * range of rows on screen; only the pages behind it (plus a little around) are requested.
 */
export function usePlaylistEntries(playlistId: string, filter: EntryFilter, visible: { first: number; last: number }) {
  const head = useQuery({
    queryKey: playlistKeys.page(playlistId, filter, 0),
    queryFn: ({ signal }) => playlistsApi.entries(playlistId, filter, { offset: 0, limit: PAGE_SIZE }, signal),
    staleTime: 15_000,
  });
  const total = head.data?.total;
  const others = useMemo(() => pagesForRange(visible.first, visible.last, total).filter((page) => page !== 0), [visible.first, visible.last, total]);
  const combine = useCallback(
    (results: UseQueryResult<PlaylistEntryPageDto>[]) => {
      const map = new Map<number, PlaylistEntryDto[]>();
      others.forEach((page, index) => {
        const data = results[index]?.data;
        if (data) map.set(page, data.items);
      });
      return map;
    },
    [others],
  );
  const rest = useQueries({
    queries: others.map((page) => ({
      queryKey: playlistKeys.page(playlistId, filter, page),
      queryFn: ({ signal }: { signal: AbortSignal }) => playlistsApi.entries(playlistId, filter, { offset: page * PAGE_SIZE, limit: PAGE_SIZE }, signal),
      staleTime: 15_000,
      enabled: total !== undefined,
    })),
    combine,
  });
  const pages = useMemo(() => {
    const map = new Map(rest);
    if (head.data) map.set(0, head.data.items);
    return map;
  }, [rest, head.data]);

  const entryAt = useCallback(
    (index: number): PlaylistEntryDto | undefined => {
      const { page, slot } = locate(index);
      return pages.get(page)?.[slot];
    },
    [pages],
  );

  return { total, entryAt, isPending: head.isPending, isError: head.isError, error: head.error, refetch: head.refetch };
}

/** Everything a change may touch: lists, detail and every cached page. Over-invalidating is cheap (only active queries refetch). */
export function invalidatePlaylists(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: playlistKeys.all }),
    queryClient.invalidateQueries({ queryKey: ['playlist'] }),
    queryClient.invalidateQueries({ queryKey: ['playlist-entries'] }),
  ]);
}

function usePlaylistMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => invalidatePlaylists(queryClient) });
}

export const useCreatePlaylist = () => usePlaylistMutation((name: string) => playlistsApi.create(name));
export const useRenamePlaylist = (id: string) => usePlaylistMutation((name: string) => playlistsApi.rename(id, name));
export const useDeletePlaylist = () => usePlaylistMutation((id: string) => playlistsApi.remove(id));

export const useEnableExport = (id: string) => usePlaylistMutation(() => playlistsApi.enableExport(id));
export const useDisableExport = (id: string) => usePlaylistMutation(() => playlistsApi.disableExport(id));

export const useCreateGroup = (id: string) => usePlaylistMutation((name: string) => playlistsApi.createGroup(id, { name }));
export const useRenameGroup = (id: string) => usePlaylistMutation((input: { groupId: string; name: string }) => playlistsApi.renameGroup(id, input.groupId, input.name));
export const useReorderGroups = (id: string) => usePlaylistMutation((groupIds: string[]) => playlistsApi.reorderGroups(id, groupIds));
export const useDeleteGroup = (id: string) => usePlaylistMutation((input: { groupId: string; deleteEntries: boolean }) => playlistsApi.deleteGroup(id, input.groupId, input.deleteEntries));

export const useAddFromSource = (id: string) => usePlaylistMutation((body: AddFromSourceRequest) => playlistsApi.addFromSource(id, body));
export const useUpdateEntry = (id: string) => usePlaylistMutation((input: { entryId: string; patch: UpdateEntryRequest }) => playlistsApi.updateEntry(id, input.entryId, input.patch));
export const useMoveEntries = (id: string) => usePlaylistMutation((body: MoveEntriesRequest) => playlistsApi.move(id, body));
export const useTransferEntries = (id: string) => usePlaylistMutation((body: TransferEntriesRequest) => playlistsApi.transfer(id, body));
export const useMergePlaylists = (id: string) => usePlaylistMutation((sourcePlaylistIds: string[]) => playlistsApi.merge(id, { sourcePlaylistIds }));
export const useRenumber = (id: string) => usePlaylistMutation((body: RenumberRequest) => playlistsApi.renumber(id, body));
export const useRelink = (id: string) => usePlaylistMutation(() => playlistsApi.relink(id));

/** Removing more entries than one request carries is split into several. */
export const useRemoveEntries = (id: string) =>
  usePlaylistMutation(async (entryIds: string[]) => {
    let removed = 0;
    for (const ids of chunk(entryIds, MAX_IDS_PER_REQUEST)) removed += (await playlistsApi.removeEntries(id, ids)).removed;
    return { removed };
  });

/**
 * Ids of every entry matching a filter, for "select all". Stops at `cap` (the person is told) so a
 * 50 000-entry playlist cannot make one click download the whole thing.
 */
export async function fetchEntryIds(playlistId: string, filter: EntryFilter, cap = MAX_IDS_PER_REQUEST): Promise<{ ids: string[]; total: number; truncated: boolean }> {
  const ids: string[] = [];
  let total = 0;
  for (let offset = 0; offset < cap; offset += MAX_PAGE_SIZE) {
    const page = await playlistsApi.entries(playlistId, filter, { offset, limit: Math.min(MAX_PAGE_SIZE, cap - offset) });
    total = page.total;
    ids.push(...page.items.map((entry) => entry.id));
    if (ids.length >= page.total) break;
  }
  return { ids, total, truncated: total > ids.length };
}

export type { PlaylistDto };

import type { OperatorChannelListDto, OperatorFavoritesImportDto, OperatorNowNextDto } from '@ziptv/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api-client';
import { userStateKeys } from '../user-state/api';

const BASE = '/api/v1/operator';

export const operatorKeys = {
  all: ['operator'] as const,
  channels: (lineup: string | null) => ['operator', 'channels', lineup ?? ''] as const,
};

/**
 * Licensed channels for this viewer. The server already filtered them by rights for the viewer's
 * market and device, so everything listed is playable here.
 */
export function useOperatorChannels(lineup: string | null = null) {
  return useQuery({
    queryKey: operatorKeys.channels(lineup),
    queryFn: ({ signal }) => apiRequest<OperatorChannelListDto>(`${BASE}/channels${lineup ? `?lineup=${encodeURIComponent(lineup)}` : ''}`, { signal }),
    staleTime: 60_000,
  });
}

/**
 * What is on now / next on the given operator channels (refreshed every minute). Channels the
 * viewer may not see are simply not answered.
 */
export function useOperatorGuide(channelIds: string[]) {
  const key = [...channelIds].sort().join(',');
  return useQuery({
    queryKey: ['operator', 'guide', key],
    queryFn: async ({ signal }) => {
      const result = new Map<string, OperatorNowNextDto>();
      // Chunks keep each URL well under proxy limits.
      for (let i = 0; i < channelIds.length; i += 200) {
        const chunk = channelIds.slice(i, i + 200);
        for (const row of await apiRequest<OperatorNowNextDto[]>(`${BASE}/guide?channels=${chunk.map(encodeURIComponent).join(',')}`, { signal })) result.set(row.channelId, row);
      }
      return result;
    },
    enabled: channelIds.length > 0,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

/** Whether the operator offers any channel to this viewer (the "Channels" navigation entry). */
export function useHasOperatorChannels(): boolean {
  return (useOperatorChannels().data?.channels.length ?? 0) > 0;
}

export function toggleOperatorFavorite(channelId: string, add: boolean): Promise<void> {
  return apiRequest<void>(`${BASE}/favorites/${channelId}`, { method: add ? 'PUT' : 'DELETE' });
}

export function useToggleOperatorFavorite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, add }: { channelId: string; add: boolean }) => toggleOperatorFavorite(channelId, add),
    // Optimistic: the star flips immediately in every cached channel list.
    onMutate: async ({ channelId, add }) => {
      await client.cancelQueries({ queryKey: operatorKeys.all });
      const previous = client.getQueriesData<OperatorChannelListDto>({ queryKey: operatorKeys.all });
      for (const [key, data] of previous) {
        if (data) client.setQueryData<OperatorChannelListDto>(key, { ...data, channels: data.channels.map((channel) => (channel.id === channelId ? { ...channel, favorite: add } : channel)) });
      }
      return { previous };
    },
    onError: (_error, _input, context) => {
      for (const [key, data] of context?.previous ?? []) client.setQueryData(key, data);
    },
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: operatorKeys.all }),
        client.invalidateQueries({ queryKey: userStateKeys.list }),
        client.invalidateQueries({ queryKey: userStateKeys.home }),
      ]),
  });
}

/** Channels of the viewer's own sources on My List that the operator also carries become favourites. */
export function useImportOperatorFavorites() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<OperatorFavoritesImportDto>(`${BASE}/favorites/import-from-my-list`, { method: 'POST' }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: operatorKeys.all }),
        client.invalidateQueries({ queryKey: userStateKeys.list }),
        client.invalidateQueries({ queryKey: userStateKeys.home }),
      ]),
  });
}

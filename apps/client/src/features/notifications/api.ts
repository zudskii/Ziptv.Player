import type { NotificationListDto } from '@ziptv/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api-client';

const KEY = ['notifications'] as const;

export function useNotifications() {
  return useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => apiRequest<NotificationListDto>('/api/v1/notifications', { signal }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[] | 'all') => apiRequest<void>('/api/v1/notifications/read', { method: 'POST', body: { ids } }),
    onSuccess: (_result, ids) => {
      queryClient.setQueryData<NotificationListDto>(KEY, (current) =>
        current
          ? {
              unread: ids === 'all' ? 0 : Math.max(0, current.unread - ids.length),
              items: current.items.map((item) => (ids === 'all' || ids.includes(item.id) ? { ...item, read: true } : item)),
            }
          : current,
      );
    },
  });
}

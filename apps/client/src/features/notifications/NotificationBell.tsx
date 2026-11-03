import type { NotificationDto } from '@ziptv/contracts';
import { Bell, CheckCheck, CircleAlert, CircleCheck, Info, Trash2, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { IconButton } from '../../components/ui/Button';
import { Popover } from '../../components/ui/Popover';
import { Segmented } from '../../components/ui/Segmented';
import { cn } from '../../lib/cn';
import { formatAgo } from '../../lib/time';
import { useClearReadNotifications, useDismissNotification, useMarkNotificationsRead, useNotifications } from './api';
import { groupByDay } from './grouping';

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert } as const;
const TONES = { info: 'text-brand-soft', success: 'text-emerald-500', warning: 'text-amber-500', error: 'text-red-500' } as const;

/**
 * Notification center: "Source refreshed · 12 new channels added", "EPG updated", security
 * notices… Grouped by day, filterable (all / unread), dismissible; warnings and errors that
 * arrive while the app is open also pop up as a toast.
 */
export function NotificationBell() {
  const { data } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const dismiss = useDismissNotification();
  const clearRead = useClearReadNotifications();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const unread = data?.unread ?? 0;
  useArrivalToasts(data?.items);

  const items = useMemo(() => (data?.items ?? []).filter((item) => filter === 'all' || !item.read), [data, filter]);
  const groups = useMemo(() => groupByDay(items), [items]);
  const hasRead = (data?.items ?? []).some((item) => item.read);

  const open = (item: NotificationDto, close: () => void) => {
    if (!item.read) markRead.mutate([item.id]);
    if (item.link) {
      close();
      navigate(item.link);
    }
  };

  return (
    <Popover
      trigger={({ toggle, open: isOpen }) => (
        <div className="relative">
          <IconButton label={unread ? `Notifications (${unread} unread)` : 'Notifications'} onClick={toggle} active={isOpen}>
            <Bell className="h-5 w-5" />
          </IconButton>
          {unread > 0 && (
            <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-live px-1 text-[10px] font-bold text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </div>
      )}
      className="w-[min(92vw,24rem)]"
    >
      {(close) => (
        <div>
          <div className="flex items-center gap-2 border-b border-line/5 px-4 py-3">
            <p className="flex-1 text-sm font-semibold">Notifications</p>
            {unread > 0 && (
              <button type="button" onClick={() => markRead.mutate('all')} className="inline-flex items-center gap-1 text-xs text-brand-soft hover:underline">
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            )}
            {hasRead && (
              <button type="button" onClick={() => clearRead.mutate()} className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg hover:underline">
                <Trash2 className="h-3.5 w-3.5" /> Clear read
              </button>
            )}
          </div>
          {(data?.items.length ?? 0) > 0 && (
            <div className="border-b border-line/5 px-4 py-2">
              <Segmented
                label="Show"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'unread', label: unread ? `Unread (${unread})` : 'Unread' },
                ]}
              />
            </div>
          )}
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-fg-muted">{filter === 'unread' && (data?.items.length ?? 0) > 0 ? 'No unread notifications.' : "You're all caught up."}</p>
          ) : (
            <div className="scrollbar-thin max-h-[60vh] overflow-y-auto">
              {groups.map((group) => (
                <section key={group.label} aria-label={group.label}>
                  <p className="sticky top-0 bg-elevated/95 px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle backdrop-blur">{group.label}</p>
                  <ul className="divide-y divide-line/5">
                    {group.items.map((item) => {
                      const Icon = ICONS[item.severity];
                      return (
                        <li key={item.id} className={cn('group/item relative flex', !item.read && 'bg-brand/5')}>
                          <button type="button" onClick={() => open(item, close)} className="flex min-w-0 flex-1 gap-3 px-4 py-3 text-left hover:bg-fg/5">
                            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONES[item.severity])} aria-hidden />
                            <span className="min-w-0 flex-1">
                              <span className={cn('block text-sm', item.read ? 'text-fg-muted' : 'font-medium text-fg')}>{item.title}</span>
                              {item.body && <span className="mt-0.5 block text-xs text-fg-muted">{item.body}</span>}
                              <span className="mt-1 block text-[11px] text-fg-subtle">{formatAgo(item.createdAt)}</span>
                            </span>
                            {!item.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" aria-label="Unread" />}
                          </button>
                          <IconButton label={`Dismiss “${item.title}”`} onClick={() => dismiss.mutate(item.id)} className="mr-1 mt-2 h-7 w-7 opacity-60 hover:opacity-100 focus-visible:opacity-100">
                            <X className="h-3.5 w-3.5" />
                          </IconButton>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      )}
    </Popover>
  );
}

/** Warnings and errors that arrive while the app is open pop up once (the first load stays quiet). */
function useArrivalToasts(items: NotificationDto[] | undefined): void {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!items) return;
    if (!seen.current) {
      seen.current = new Set(items.map((item) => item.id));
      return;
    }
    for (const item of items) {
      if (seen.current.has(item.id)) continue;
      seen.current.add(item.id);
      if (item.read || (item.severity !== 'warning' && item.severity !== 'error')) continue;
      (item.severity === 'error' ? toast.error : toast.warning)(item.title, { description: item.body ?? undefined });
    }
  }, [items]);
}

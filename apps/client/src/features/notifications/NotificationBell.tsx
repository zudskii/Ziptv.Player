import type { NotificationDto } from '@ziptv/contracts';
import { Bell, CheckCheck, CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { useNavigate } from 'react-router';

import { IconButton } from '../../components/ui/Button';
import { Popover } from '../../components/ui/Popover';
import { cn } from '../../lib/cn';
import { formatAgo } from '../../lib/time';
import { useMarkNotificationsRead, useNotifications } from './api';

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert } as const;
const TONES = { info: 'text-brand-soft', success: 'text-emerald-500', warning: 'text-amber-500', error: 'text-red-500' } as const;

/** Notification center: "Source refreshed · 12 new channels added", "EPG updated", … */
export function NotificationBell() {
  const { data } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const navigate = useNavigate();
  const unread = data?.unread ?? 0;

  const open = (item: NotificationDto, close: () => void) => {
    if (!item.read) markRead.mutate([item.id]);
    close();
    if (item.link) navigate(item.link);
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
      className="w-[min(92vw,22rem)]"
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between border-b border-line/5 px-4 py-3">
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && (
              <button type="button" onClick={() => markRead.mutate('all')} className="inline-flex items-center gap-1 text-xs text-brand-soft hover:underline">
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            )}
          </div>
          {!data || data.items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-fg-muted">You're all caught up.</p>
          ) : (
            <ul className="scrollbar-thin max-h-[60vh] divide-y divide-line/5 overflow-y-auto">
              {data.items.map((item) => {
                const Icon = ICONS[item.severity];
                return (
                  <li key={item.id}>
                    <button type="button" onClick={() => open(item, close)} className={cn('flex w-full gap-3 px-4 py-3 text-left hover:bg-fg/5', !item.read && 'bg-brand/5')}>
                      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONES[item.severity])} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block text-sm', item.read ? 'text-fg-muted' : 'font-medium text-fg')}>{item.title}</span>
                        {item.body && <span className="mt-0.5 block text-xs text-fg-muted">{item.body}</span>}
                        <span className="mt-1 block text-[11px] text-fg-subtle">{formatAgo(item.createdAt)}</span>
                      </span>
                      {!item.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" aria-label="Unread" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Popover>
  );
}

import { useVirtualizer } from '@tanstack/react-virtual';
import type { UnplayableReason } from '@ziptv/contracts';
import { Star } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { cn } from '../../../lib/cn';
import type { BrowsableChannel } from '../browse';
import { ChannelLogo } from './ChannelLogo';

const ROW_HEIGHT = 56;

const UNPLAYABLE_LABELS: Record<UnplayableReason, string> = {
  unsupported_protocol: 'RTMP/UDP — not playable in browsers',
  drm: 'DRM protected',
  web_page: 'Web page link',
};

interface ChannelListProps {
  sourceId: string;
  channels: BrowsableChannel[];
  activeKey: string | undefined;
  favorites: ReadonlySet<string>;
  showGroups: boolean;
  onSelect: (channel: BrowsableChannel) => void;
  onToggleFavorite: (channel: BrowsableChannel) => void;
}

/** Virtualised: 50k-channel playlists render as fast as 50-channel ones. */
export function ChannelList({ sourceId, channels, activeKey, favorites, showGroups, onSelect, onToggleFavorite }: ChannelListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is designed for this usage.
  const virtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => channels[index]?.key ?? index,
  });

  // Keep the playing channel visible (e.g. after next/previous via keyboard).
  useEffect(() => {
    if (!activeKey) return;
    const index = channels.findIndex((channel) => channel.key === activeKey);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
  }, [activeKey, channels, virtualizer]);

  return (
    <div ref={scrollRef} data-channel-list className="scrollbar-thin h-full overflow-y-auto overscroll-contain" role="listbox" aria-label="Channels">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const channel = channels[item.index];
          if (!channel) return null;
          const active = channel.key === activeKey;
          const favorite = favorites.has(channel.key);
          return (
            <div
              key={item.key}
              role="option"
              aria-selected={active}
              className={cn(
                'absolute left-0 top-0 flex w-full items-center gap-1 rounded-lg pr-1 transition-colors',
                active ? 'bg-brand/15 ring-1 ring-inset ring-brand/40' : 'hover:bg-fg/5',
              )}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <button
                type="button"
                onClick={() => onSelect(channel)}
                className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-lg px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
              >
                <ChannelLogo key={channel.key} sourceId={sourceId} channel={channel} className="h-10 w-14" />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-sm', active ? 'font-semibold text-fg' : 'text-fg', channel.unplayableReason && 'text-fg-muted')}>
                    {channel.name}
                  </span>
                  {channel.unplayableReason ? (
                    <span className="block truncate text-xs text-amber-500/90">{UNPLAYABLE_LABELS[channel.unplayableReason]}</span>
                  ) : (
                    showGroups &&
                    channel.groups.length > 0 && <span className="block truncate text-xs text-fg-subtle">{channel.groups.join(' · ')}</span>
                  )}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onToggleFavorite(channel)}
                aria-label={favorite ? `Remove ${channel.name} from favorites` : `Add ${channel.name} to favorites`}
                aria-pressed={favorite}
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-fg/10',
                  favorite ? 'text-amber-400' : 'text-fg-subtle/60 hover:text-fg-muted',
                )}
              >
                <Star className={cn('h-4 w-4', favorite && 'fill-current')} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useVirtualizer } from '@tanstack/react-virtual';
import type { NowNextDto, UnplayableReason } from '@ziptv/contracts';
import { History, Lock, Star } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { cn } from '../../../lib/cn';
import { formatClock, formatRange } from '../../../lib/time';
import { useNow } from '../../../lib/use-now';
import { useDisplayPrefs } from '../../user-state/display-prefs';
import { programmeProgress } from '../../epg/programme';
import type { BrowsableChannel } from '../browse';
import { ChannelLogo } from './ChannelLogo';

const ROW_HEIGHT = 56;
const ROW_HEIGHT_EPG = 84;

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
  /** Now/next per channel key (EPG). */
  nowNext?: Record<string, NowNextDto>;
  onSelect: (channel: BrowsableChannel) => void;
  onToggleFavorite: (channel: BrowsableChannel) => void;
}

/**
 * Virtualised channel list: 50k-channel sources render as fast as 50-channel ones.
 * Channels with a guide show what is on now, its progress and what comes next.
 */
export function ChannelList({ sourceId, channels, activeKey, favorites, showGroups, nowNext, onSelect, onToggleFavorite }: ChannelListProps) {
  const now = useNow(30_000);
  const showProgress = useDisplayPrefs((state) => state.showProgress);
  useDisplayPrefs((state) => state.use24h); // re-render times when the clock format changes
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = (index: number) => (nowNext?.[channels[index]?.key ?? '']?.now ? ROW_HEIGHT_EPG : ROW_HEIGHT);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is designed for this usage.
  const virtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: rowHeight,
    overscan: 10,
    getItemKey: (index) => channels[index]?.key ?? index,
  });

  // Row heights change when now/next arrives or programmes roll over.
  useEffect(() => {
    virtualizer.measure();
  }, [nowNext, virtualizer]);

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
          const entry = nowNext?.[channel.key];
          const current = entry?.now ?? null;
          return (
            <div
              key={item.key}
              role="option"
              aria-selected={active}
              aria-label={channel.name}
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
                <ChannelLogo sourceId={sourceId} channel={channel} className="h-10 w-14" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={cn('truncate text-sm', active ? 'font-semibold text-fg' : 'text-fg', channel.unplayableReason && 'text-fg-muted')}>{channel.name}</span>
                    {channel.locked && <Lock className="h-3 w-3 shrink-0 text-amber-500" aria-label="Locked" />}
                    {(channel.catchupDays ?? 0) > 0 && <History className="h-3 w-3 shrink-0 text-fg-subtle" aria-label={`Archive ${channel.catchupDays} days`} />}
                  </span>
                  {channel.unplayableReason ? (
                    <span className="block truncate text-xs text-amber-500/90">{UNPLAYABLE_LABELS[channel.unplayableReason]}</span>
                  ) : current ? (
                    <>
                      <span className="flex items-baseline gap-1.5 text-xs">
                        <span className="shrink-0 font-semibold uppercase tracking-wide text-live">Live</span>
                        <span className="truncate text-fg-muted">{current.title}</span>
                        <span className="ml-auto shrink-0 font-mono tabular-nums text-fg-subtle">{formatRange(current.start, current.end)}</span>
                      </span>
                      {showProgress && (
                        <span className="mt-1 block h-0.5 overflow-hidden rounded-full bg-fg/10">
                          <span className="block h-full rounded-full bg-live/80" style={{ width: `${Math.round(programmeProgress(current, now) * 100)}%` }} />
                        </span>
                      )}
                      {entry?.next && (
                        <span className="mt-0.5 block truncate text-[11px] text-fg-subtle">
                          Next: {entry.next.title} · {formatClock(entry.next.start)}
                        </span>
                      )}
                    </>
                  ) : (
                    showGroups && channel.groups.length > 0 && <span className="block truncate text-xs text-fg-subtle">{channel.groups.join(' · ')}</span>
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

import type { ChannelDto, GuideDto, ProgrammeDto, SourceDto } from '@ziptv/contracts';
import { useQueries } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { History, Play } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import { Spinner } from '../../../components/ui/Spinner';
import { cn } from '../../../lib/cn';
import { formatClock } from '../../../lib/time';
import { useIsDesktop } from '../../../lib/use-media-query';
import { useNow } from '../../../lib/use-now';
import { ChannelLogo } from '../../live/components/ChannelLogo';
import { guideGridQuery } from '../api';
import { blockGeometry, offsetFor, pagesFor, timeSlots, windowWidth, type DayWindow } from '../guide-layout';
import { programmeState } from '../programme';

const ROW_HEIGHT = 64;
const RULER_HEIGHT = 36;
const PAGE_SIZE = 40;

interface GuideGridProps {
  source: SourceDto;
  window: DayWindow;
  group: string;
  onOpenProgramme: (channel: ChannelDto, programme: ProgrammeDto) => void;
  onPlayChannel: (channel: ChannelDto) => void;
  /** Bumped by the "Now" button to scroll back to the current time. */
  scrollToNowSignal: number;
}

/**
 * Full TV Guide:
 *            14:00      15:00      16:00
 *   BBC      News       Movie      News
 *   ESPN     Football──────────    Sports
 * Rows are virtualised and loaded in pages of 40 channels, so 5 000-channel sources stay fast.
 */
export function GuideGrid({ source, window, group, onOpenProgramme, onPlayChannel, scrollToNowSignal }: GuideGridProps) {
  const isDesktop = useIsDesktop();
  const pxPerMinute = isDesktop ? 4 : 3;
  const channelColumn = isDesktop ? 208 : 116;
  const now = useNow(30_000);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = windowWidth(window, pxPerMinute);

  const first = useQueries({
    queries: [{ ...guideGridQuery({ source, from: window.start, to: window.end, group, offset: 0, limit: PAGE_SIZE }) }],
  })[0]!;
  const total = first.data?.total ?? 0;

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is designed for this usage.
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
    paddingStart: RULER_HEIGHT,
  });
  const items = virtualizer.getVirtualItems();
  const pages = pagesFor(items[0]?.index ?? 0, items.at(-1)?.index ?? -1, PAGE_SIZE);
  const pageQueries = useQueries({
    queries: pages.map((page) => guideGridQuery({ source, from: window.start, to: window.end, group, offset: page * PAGE_SIZE, limit: PAGE_SIZE })),
  });
  const rows = useMemo(() => {
    const map = new Map<number, GuideDto['rows'][number]>();
    const add = (data: GuideDto | undefined) => data?.rows.forEach((row, index) => map.set(data.offset + index, row));
    add(first.data);
    pageQueries.forEach((query) => add(query.data));
    return map;
  }, [first.data, pageQueries]);

  // Scroll to "now" (or the start of the day) when the day/source changes or "Now" is pressed.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const target = now >= window.start && now < window.end ? offsetFor(now, window, pxPerMinute) - 45 * pxPerMinute : offsetFor(window.start + 18 * 3_600_000, window, pxPerMinute);
    element.scrollTo({ left: Math.max(0, target), behavior: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on day/source/zoom changes (and first data), not every clock tick
  }, [window.start, source.id, pxPerMinute, scrollToNowSignal, first.isSuccess]);

  if (first.isPending) return <Spinner className="py-24" label="Loading the guide…" />;
  if (first.isError) return <p className="py-16 text-center text-sm text-fg-muted">The guide could not be loaded.</p>;
  if (total === 0) return <p className="py-16 text-center text-sm text-fg-muted">No channels in this group.</p>;

  const nowOffset = now >= window.start && now < window.end ? offsetFor(now, window, pxPerMinute) : null;

  return (
    <div ref={scrollRef} className="scrollbar-thin relative h-full overflow-auto overscroll-contain rounded-xl border border-line/5 bg-surface/60" role="grid" aria-label="TV guide" aria-rowcount={total}>
      <div className="relative" style={{ width: channelColumn + width, height: virtualizer.getTotalSize() }}>
        {/* Time ruler */}
        <div className="sticky top-0 z-30 flex" style={{ height: RULER_HEIGHT, width: channelColumn + width }}>
          <div className="sticky left-0 z-10 shrink-0 border-b border-r border-line/10 bg-surface" style={{ width: channelColumn }} />
          <div className="relative border-b border-line/10 bg-surface/95 backdrop-blur" style={{ width }}>
            {timeSlots(window, 30).map((slot) => (
              <span
                key={slot}
                className={cn('absolute top-0 flex h-full items-center border-l border-line/10 pl-1.5 text-xs tabular-nums', new Date(slot).getMinutes() === 0 ? 'font-semibold text-fg-muted' : 'text-fg-subtle')}
                style={{ left: offsetFor(slot, window, pxPerMinute) }}
              >
                {formatClock(slot)}
              </span>
            ))}
            {nowOffset !== null && <span className="absolute bottom-0 h-2 w-2 -translate-x-1/2 translate-y-1/2 rotate-45 bg-live" style={{ left: nowOffset }} />}
          </div>
        </div>

        {nowOffset !== null && (
          <div className="pointer-events-none absolute bottom-0 z-20 w-0.5 bg-live/80" style={{ left: channelColumn + nowOffset, top: RULER_HEIGHT }} aria-hidden />
        )}

        {items.map((item) => {
          const row = rows.get(item.index);
          return (
            <div key={item.key} role="row" className="absolute left-0 flex border-b border-line/5" style={{ top: item.start, height: item.size, width: channelColumn + width }}>
              <div role="rowheader" className="sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r border-line/10 bg-surface px-2" style={{ width: channelColumn }}>
                {row ? (
                  <button type="button" onClick={() => onPlayChannel(row.channel)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-fg/5" title={`Watch ${row.channel.name}`}>
                    <ChannelLogo sourceId={source.id} channel={row.channel} className="h-8 w-10 sm:h-9 sm:w-12" />
                    <span className="line-clamp-2 min-w-0 flex-1 break-words text-[11px] font-medium leading-tight text-fg sm:text-sm">{row.channel.name}</span>
                  </button>
                ) : (
                  <span className="h-9 w-full animate-pulse rounded bg-fg/5" />
                )}
              </div>
              <div className="relative" style={{ width }}>
                {row?.programmes.map((programme) => {
                  const geometry = blockGeometry(programme, window, pxPerMinute);
                  if (!geometry) return null;
                  const state = programmeState(programme, now);
                  return (
                    <button
                      key={programme.id}
                      type="button"
                      role="gridcell"
                      onClick={() => onOpenProgramme(row.channel, programme)}
                      className={cn(
                        'absolute top-1 bottom-1 rounded-md border text-left transition-colors',
                        state === 'live'
                          ? 'border-live/40 bg-live/10 hover:bg-live/15'
                          : state === 'past'
                            ? 'border-line/5 bg-fg/[0.03] text-fg-muted hover:bg-fg/[0.06]'
                            : 'border-line/10 bg-fg/[0.05] hover:bg-fg/10',
                      )}
                      style={{ left: geometry.left + 1, width: Math.max(2, geometry.width - 2) }}
                      title={`${programme.title} · ${formatClock(programme.start)}–${formatClock(programme.end)}`}
                    >
                      {/* Sticky label: a programme that started off-screen keeps its title readable. */}
                      <span className="sticky inline-block w-max max-w-full overflow-hidden px-2 py-1 align-top" style={{ left: channelColumn }}>
                        <span className={cn('flex items-center gap-1 truncate text-xs sm:text-sm', state === 'live' ? 'font-semibold text-fg' : '')}>
                          {state === 'past' && programme.catchup && <History className="h-3 w-3 shrink-0 text-brand-soft" aria-label="Watch from archive" />}
                          {state === 'live' && <Play className="h-3 w-3 shrink-0 fill-current text-live" aria-hidden />}
                          <span className="truncate">{programme.title}</span>
                        </span>
                        <span className="block truncate text-[11px] tabular-nums text-fg-subtle">{formatClock(programme.start)}</span>
                      </span>
                    </button>
                  );
                })}
                {row && row.programmes.length === 0 && (
                  // Sticky next to the channel column so the hint stays visible while scrolling in time.
                  <span className="sticky inline-flex h-full w-max items-center px-3 text-xs text-fg-subtle" style={{ left: channelColumn }}>
                    {row.channel.hasEpg ? 'No programmes' : 'No guide for this channel'}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

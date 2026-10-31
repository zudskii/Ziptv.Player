import type { ChannelDto, ProgrammeDto, SourceDto } from '@ziptv/contracts';
import { CalendarX, History, Play } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import { Spinner } from '../../../components/ui/Spinner';
import { cn } from '../../../lib/cn';
import { formatClock, formatDay } from '../../../lib/time';
import { useNow } from '../../../lib/use-now';
import { useChannelSchedule } from '../api';
import { currentIndex, programmeProgress, programmeState } from '../programme';

interface MiniGuideProps {
  source: SourceDto;
  channel: Pick<ChannelDto, 'key' | 'name' | 'hasEpg' | 'catchupDays'>;
  onSelect: (programme: ProgrammeDto) => void;
  onWatchArchive?: (programme: ProgrammeDto) => void;
  className?: string;
}

/**
 * Schedule of the channel being watched (past with archive, on air, upcoming):
 *   14:00 Football · 16:00 Sports News · 16:30 Highlights
 */
export function MiniGuide({ source, channel, onSelect, onWatchArchive, className }: MiniGuideProps) {
  const now = useNow(30_000);
  const schedule = useChannelSchedule(source, channel.key, channel.hasEpg);
  const listRef = useRef<HTMLOListElement>(null);
  const programmes = useMemo(() => schedule.data?.programmes ?? [], [schedule.data]);
  const focus = programmes.length ? currentIndex(programmes, now) : -1;

  // Keep the programme on air in view when the schedule loads or the channel changes.
  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(`[data-index="${focus}"]`);
    if (item && listRef.current) listRef.current.scrollTop = Math.max(0, item.offsetTop - listRef.current.offsetTop - 8);
  }, [focus, channel.key, schedule.data]);

  if (!channel.hasEpg) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-fg-muted', className)}>
        <CalendarX className="h-6 w-6 text-fg-subtle" />
        No programme guide for this channel.
      </div>
    );
  }
  if (schedule.isPending) return <Spinner className={cn('py-10', className)} label="Loading schedule…" />;
  if (programmes.length === 0) {
    return <p className={cn('p-6 text-center text-sm text-fg-muted', className)}>The guide has no programmes for this channel right now.</p>;
  }

  const days = programmes.map((programme) => formatDay(programme.start, now));
  return (
    <ol ref={listRef} className={cn('scrollbar-thin space-y-1 overflow-y-auto pr-1', className)} aria-label={`${channel.name} schedule`}>
      {programmes.map((programme, index) => {
        const state = programmeState(programme, now);
        const day = days[index]!;
        const showDay = index === 0 || day !== days[index - 1];
        return (
          <li key={programme.id} data-index={index}>
            {showDay && <p className="sticky top-0 z-10 bg-surface/95 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle backdrop-blur">{day}</p>}
            <div
              className={cn(
                'group flex items-center gap-2 rounded-lg px-2 py-1.5',
                state === 'live' ? 'bg-live/10 ring-1 ring-inset ring-live/30' : 'hover:bg-fg/5',
                state === 'past' && !programme.catchup && 'opacity-60',
              )}
            >
              <button type="button" onClick={() => onSelect(programme)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <span className={cn('w-12 shrink-0 font-mono text-xs tabular-nums', state === 'live' ? 'font-semibold text-live' : 'text-fg-subtle')}>{formatClock(programme.start)}</span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-sm', state === 'live' ? 'font-semibold text-fg' : 'text-fg')}>{programme.title}</span>
                  {state === 'live' && (
                    <span className="mt-1 block h-0.5 overflow-hidden rounded bg-fg/10">
                      <span className="block h-full bg-live" style={{ width: `${Math.round(programmeProgress(programme, now) * 100)}%` }} />
                    </span>
                  )}
                </span>
              </button>
              {state === 'past' && programme.catchup && onWatchArchive && (
                <button
                  type="button"
                  onClick={() => onWatchArchive(programme)}
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-brand/10 px-2 text-xs font-medium text-brand-soft hover:bg-brand/20"
                  aria-label={`Watch ${programme.title} from the archive`}
                >
                  <Play className="h-3 w-3 fill-current" /> Watch
                </button>
              )}
              {state === 'past' && programme.catchup && !onWatchArchive && <History className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-label="In archive" />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

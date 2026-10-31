import type { ChannelDto, NowNextDto, ProgrammeDto } from '@ziptv/contracts';
import { CalendarCog, Star } from 'lucide-react';

import { Badge, LiveBadge } from '../../../components/ui/Badge';
import { IconButton } from '../../../components/ui/Button';
import { ProgressBar } from '../../../components/ui/ProgressBar';
import { cn } from '../../../lib/cn';
import { formatClock, formatRange } from '../../../lib/time';
import { useNow } from '../../../lib/use-now';
import { ChannelLogo } from '../../live/components/ChannelLogo';
import { minutesLeft, programmeProgress } from '../programme';

interface LiveNowCardProps {
  sourceId: string;
  channel: ChannelDto;
  entry: NowNextDto | undefined;
  favorite: boolean;
  onToggleFavorite: () => void;
  onOpenMapping: () => void;
  onSelectProgramme: (programme: ProgrammeDto) => void;
}

/**
 * The channel being watched:  Eurosport 1 · LIVE · ATP Beijing 14:00–16:00 ████░ 72% · Next: Sports News 16:00
 */
export function LiveNowCard({ sourceId, channel, entry, favorite, onToggleFavorite, onOpenMapping, onSelectProgramme }: LiveNowCardProps) {
  const now = useNow(30_000);
  const current = entry?.now ?? null;
  const next = entry?.next ?? null;

  return (
    <section className="card p-3 sm:p-4" aria-label="Now playing">
      <div className="flex items-start gap-3">
        <ChannelLogo sourceId={sourceId} channel={channel} className="h-12 w-16" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold text-fg">{channel.name}</h1>
            <LiveBadge />
            {channel.catchupDays && <Badge tone="brand">Archive {channel.catchupDays}d</Badge>}
          </div>
          <p className="truncate text-xs text-fg-subtle">{channel.groups.length > 0 ? channel.groups.join(' · ') : 'Uncategorized'}</p>
        </div>
        <IconButton label="Programme guide source" onClick={onOpenMapping}>
          <CalendarCog className="h-4 w-4" />
        </IconButton>
        <IconButton label={favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={onToggleFavorite} active={favorite}>
          <Star className={cn('h-4 w-4', favorite && 'fill-current text-amber-400')} />
        </IconButton>
      </div>

      {current ? (
        <button type="button" onClick={() => onSelectProgramme(current)} className="mt-3 block w-full rounded-lg p-2 text-left hover:bg-fg/5">
          <p className="flex items-baseline justify-between gap-3">
            <span className="truncate font-medium text-fg">{current.title}</span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-fg-muted">{formatRange(current.start, current.end)}</span>
          </p>
          <div className="mt-2 flex items-center gap-3">
            <ProgressBar value={programmeProgress(current, now)} tone="live" className="flex-1" label={`${current.title} progress`} />
            <span className="w-24 shrink-0 text-right text-xs text-fg-subtle">
              {Math.round(programmeProgress(current, now) * 100)}% · {minutesLeft(current, now)} min left
            </span>
          </div>
          {current.description && <p className="mt-2 line-clamp-2 text-sm text-fg-muted">{current.description}</p>}
        </button>
      ) : (
        <p className="mt-3 px-2 text-sm text-fg-subtle">{channel.hasEpg ? 'No programme information right now.' : 'This channel has no programme guide.'}</p>
      )}
      {next && (
        <button type="button" onClick={() => onSelectProgramme(next)} className="mt-1 flex w-full items-baseline gap-2 rounded-lg px-2 py-1 text-left text-sm hover:bg-fg/5">
          <span className="text-fg-subtle">Next:</span>
          <span className="min-w-0 flex-1 truncate text-fg">{next.title}</span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-fg-subtle">{formatClock(next.start)}</span>
        </button>
      )}
    </section>
  );
}

/** Drawn over the video while controls are visible: logo, channel, programme, timeline, next. */
export function LiveInfoOverlay({ sourceId, channel, entry }: { sourceId: string; channel: ChannelDto; entry: NowNextDto | undefined }) {
  const now = useNow(30_000);
  const current = entry?.now ?? null;
  return (
    <div className="flex items-start gap-3 bg-gradient-to-b from-black/80 via-black/40 to-transparent p-3 pb-10 text-white sm:p-4 sm:pb-12">
      <ChannelLogo sourceId={sourceId} channel={channel} className="hidden h-10 w-14 bg-white/10 xs:flex" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{channel.name}</p>
        {current ? (
          <>
            <p className="truncate text-sm text-white/85">
              {current.title} <span className="font-mono text-xs text-white/60">{formatRange(current.start, current.end)}</span>
            </p>
            <div className="mt-1.5 h-1 w-full max-w-sm overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-live" style={{ width: `${Math.round(programmeProgress(current, now) * 100)}%` }} />
            </div>
            {entry?.next && (
              <p className="mt-1 truncate text-xs text-white/60">
                Next: {entry.next.title} · {formatClock(entry.next.start)}
              </p>
            )}
          </>
        ) : (
          <p className="truncate text-xs text-white/60">{channel.groups[0] ?? 'Live'}</p>
        )}
      </div>
    </div>
  );
}

import type { ChannelDto, ProgrammeDto, SourceDto } from '@ziptv/contracts';
import { CalendarClock, LayoutGrid, Server, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';

import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { cn } from '../../lib/cn';
import { PROBLEMS } from '../../lib/problems';
import { formatDay } from '../../lib/time';
import { useNow } from '../../lib/use-now';
import { useGuides } from '../../features/epg/api';
import { GuideGrid } from '../../features/epg/components/GuideGrid';
import { ProgrammeDialog } from '../../features/epg/components/ProgrammeDialog';
import { dayWindow } from '../../features/epg/guide-layout';
import { buildGroupOptions } from '../../features/live/browse';
import { usePlayerPrefs } from '../../features/player/player-prefs';
import { useChannelList, useSources } from '../../features/sources/api';

const DAYS_AHEAD = 6;

/** TV Guide: the full grid (channels × time) of one source, day by day. */
export function GuidePage() {
  const { sourceId } = useParams();
  const navigate = useNavigate();
  const sourcesQuery = useSources();
  const remembered = usePlayerPrefs((state) => state.activeSourceId);
  const sources = (sourcesQuery.data ?? []).filter((source) => source.revision > 0 && source.stats.live > 0);
  const source = sources.find((item) => item.id === sourceId) ?? sources.find((item) => item.id === remembered) ?? sources[0];

  useEffect(() => {
    if (source && source.id !== sourceId) navigate(`/guide/${source.id}`, { replace: true });
  }, [source, sourceId, navigate]);

  if (sourcesQuery.isPending) return <Spinner className="py-24" />;
  if ((sourcesQuery.data ?? []).length === 0) return <Navigate to="/welcome" replace />;
  if (!source) {
    return <EmptyState className="m-6" icon={<LayoutGrid className="h-8 w-8" />} title="No live channels yet" description="The TV Guide appears once a source with live channels has synced." />;
  }
  return <GuideView key={source.id} source={source} sources={sources} />;
}

function GuideView({ source, sources }: { source: SourceDto; sources: SourceDto[] }) {
  const navigate = useNavigate();
  const guides = useGuides();
  const channels = useChannelList(source);
  const [dayOffset, setDayOffset] = useState(0);
  const [group, setGroup] = useState('');
  const [selected, setSelected] = useState<{ channel: ChannelDto; programme: ProgrammeDto } | null>(null);
  const [nowSignal, setNowSignal] = useState(0);
  const now = useNow(60_000);
  const window = useMemo(() => dayWindow(now, dayOffset), [now, dayOffset]);

  const maxArchive = useMemo(() => Math.min(7, (channels.data?.channels ?? []).reduce((max, channel) => Math.max(max, channel.catchupDays ?? 0), 0)), [channels.data]);
  const days = useMemo(() => Array.from({ length: maxArchive + 1 + DAYS_AHEAD }, (_, index) => index - maxArchive), [maxArchive]);
  const groups = useMemo(() => buildGroupOptions(channels.data?.channels ?? [], 0, 0).filter((option) => option.value !== 'all'), [channels.data]);

  const sourceGuides = (guides.data ?? []).filter((guide) => guide.sourceIds.includes(source.id));
  const guideFailed = sourceGuides.length > 0 && sourceGuides.every((guide) => guide.sync.status === 'failed' || !guide.sync.lastSuccessAt) && sourceGuides.some((guide) => guide.sync.status === 'failed');

  return (
    <div className="flex h-[calc(100dvh-3.5rem-4rem)] flex-col gap-3 p-3 sm:p-5 lg:h-[calc(100dvh-3.5rem)]">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-bold text-fg sm:text-2xl">TV Guide</h1>
        {sources.length > 1 && (
          <label className="relative">
            <span className="sr-only">Source</span>
            <Server className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <select value={source.id} onChange={(event) => navigate(`/guide/${event.target.value}`)} className="field h-9 w-auto appearance-none pl-8 pr-8">
              {sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span className="sr-only">Group</span>
          <select value={group} onChange={(event) => setGroup(event.target.value)} className="field h-9 w-auto max-w-[12rem] appearance-none pr-8">
            <option value="">All channels</option>
            {groups.map((option) => (
              <option key={option.value} value={option.value === 'none' ? '\u0000none' : option.value.slice(2)}>
                {option.label} ({option.count})
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          icon={<CalendarClock className="h-4 w-4" />}
          onClick={() => {
            setDayOffset(0);
            setNowSignal((value) => value + 1);
          }}
        >
          Now
        </Button>
      </header>

      <nav className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1" aria-label="Day">
        {days.map((offset) => (
          <button
            key={offset}
            type="button"
            onClick={() => setDayOffset(offset)}
            aria-pressed={offset === dayOffset}
            className={cn(
              'shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
              offset === dayOffset ? 'bg-brand text-white' : 'bg-fg/5 text-fg-muted hover:bg-fg/10 hover:text-fg',
            )}
          >
            {formatDay(dayWindow(now, offset).start, now)}
          </button>
        ))}
      </nav>

      {guideFailed && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-fg">{PROBLEMS.epg_unavailable.title}</p>
            <p className="text-fg-muted">{PROBLEMS.epg_unavailable.description}</p>
          </div>
          <Link to="/sources" className="shrink-0 text-brand-soft hover:underline">
            Manage guides
          </Link>
        </div>
      )}
      {!guideFailed && source.stats.epgMapped === 0 && (
        <div className="rounded-lg border border-line/10 bg-fg/[0.03] p-3 text-sm text-fg-muted">
          {sourceGuides.length === 0 ? 'This source does not announce a programme guide.' : 'The guide is loading or none of its channels matched yet.'}{' '}
          <Link to="/sources" className="text-brand-soft hover:underline">
            Add an XMLTV guide
          </Link>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <GuideGrid
          source={source}
          window={window}
          group={group}
          scrollToNowSignal={nowSignal}
          onOpenProgramme={(channel, programme) => setSelected({ channel, programme })}
          onPlayChannel={(channel) => navigate(`/live/${source.id}/${channel.key}`)}
        />
      </div>

      <ProgrammeDialog
        programme={selected?.programme ?? null}
        channel={selected?.channel ?? null}
        onClose={() => setSelected(null)}
        onWatchLive={() => selected && navigate(`/live/${source.id}/${selected.channel.key}`)}
      />
    </div>
  );
}

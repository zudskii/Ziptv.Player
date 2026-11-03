import type { ContentRefDto, OperatorChannelDto } from '@ziptv/contracts';
import { ListFilter, Lock, Search, Star, Tv, X } from 'lucide-react';
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';

import { EmptyState } from '../components/ui/EmptyState';
import { Img, Initials } from '../components/ui/Img';
import { Spinner } from '../components/ui/Spinner';
import { useOperatorChannels, useOperatorGuide, useToggleOperatorFavorite } from '../features/operator/api';
import { VideoPlayer } from '../features/player/components/VideoPlayer';
import { errorMessage } from '../lib/api-client';
import { cn } from '../lib/cn';
import { imageSources } from '../lib/images';
import { paths } from '../lib/routes';
import { matchesQuery, normalizeForSearch } from '../lib/search';

const FAVORITES = '__favorites__';

/**
 * /channels/:channelId? — the operator's licensed channels. Only channels licensed for the viewer
 * (market, device, time) are listed; those outside the viewer's packages are marked locked.
 * Playback is authorized per viewing (playback session) and always goes through the ZIPTV proxy.
 */
export function ChannelsPage() {
  const { channelId } = useParams();
  const navigate = useNavigate();
  const [lineup, setLineup] = useState<string | null>(null);
  const query = useOperatorChannels(lineup);
  const toggle = useToggleOperatorFavorite();
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);

  const channels = useMemo(() => query.data?.channels ?? [], [query.data]);
  const categories = useMemo(() => [...new Set(channels.map((channel) => channel.category).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b)), [channels]);
  const visible = useMemo(() => {
    const term = normalizeForSearch(deferredSearch);
    return channels.filter((channel) => {
      if (filter === FAVORITES ? !channel.favorite : filter && channel.category !== filter) return false;
      return matchesQuery(normalizeForSearch(channel.name), term) || (channel.number !== null && String(channel.number) === term);
    });
  }, [channels, filter, deferredSearch]);

  const current = channelId ? channels.find((channel) => channel.id === channelId) : undefined;
  const guide = useOperatorGuide(useMemo(() => channels.map((channel) => channel.id), [channels]));
  const currentGuide = current ? guide.data?.get(current.id) : undefined;
  const content = useMemo<ContentRefDto | undefined>(() => (channelId ? { type: 'operator', channelId } : undefined), [channelId]);
  const zapList = visible.length > 0 ? visible : channels;
  const zap = useCallback(
    (step: 1 | -1) => {
      if (zapList.length === 0) return;
      const index = zapList.findIndex((channel) => channel.id === channelId);
      const next = zapList[(index + step + zapList.length) % zapList.length]!;
      navigate(paths.operatorChannel(next.id), { replace: true });
    },
    [zapList, channelId, navigate],
  );
  const toggleFavorite = (channel: OperatorChannelDto) =>
    toggle.mutate({ channelId: channel.id, add: !channel.favorite }, { onError: (error) => toast.error('Favourites were not updated', { description: errorMessage(error) }) });

  if (query.isPending) return <Spinner className="min-h-[50vh] justify-center" label="Loading channels…" />;
  if (query.isError) return <EmptyState className="m-5" title="Channels could not be loaded" description={errorMessage(query.error)} />;
  if (channels.length === 0 && !lineup) {
    return <EmptyState className="m-5" icon={<Tv className="h-8 w-8" />} title="No channels available here" description="ZIPTV has no licensed channels for your region and device yet." />;
  }

  return (
    <div className="mx-auto grid w-full max-w-[1600px] gap-4 p-3 sm:p-5 lg:h-[calc(100dvh-3.5rem)] lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
      <section className="flex min-w-0 flex-col gap-3 lg:overflow-y-auto" aria-label="Player">
        <div className="sticky top-14 z-20 lg:static">
          <VideoPlayer content={content} title={current?.name} onNext={() => zap(1)} onPrevious={() => zap(-1)} onBack={() => navigate('/channels')} />
        </div>
        {current ? (
          <div className="card flex items-center gap-3 p-3">
            <ChannelLogo channel={current} className="h-12 w-16" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold text-fg">
                {current.number !== null && <span className="mr-2 tabular-nums text-fg-subtle">{current.number}</span>}
                {current.name}
              </h1>
              <p className="truncate text-sm text-fg-muted">{[current.category, current.languages.map((language) => language.toUpperCase()).join(', ')].filter(Boolean).join(' · ')}</p>
              {currentGuide?.now && (
                <p className="mt-1 truncate text-sm text-fg" aria-label="On now">
                  <span className="mr-1.5 text-xs font-semibold uppercase text-brand">Now</span>
                  {currentGuide.now.title}
                  <span className="ml-1.5 text-xs text-fg-subtle">until {clock(currentGuide.now.stop)}</span>
                  {currentGuide.next && <span className="ml-3 text-xs text-fg-subtle">Next {clock(currentGuide.next.start)} · {currentGuide.next.title}</span>}
                </p>
              )}
            </div>
            {current.locked && (
              <Link to="/plans" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-brand px-2.5 text-xs font-medium text-white hover:bg-brand-strong">
                <Lock className="h-3.5 w-3.5" aria-hidden /> {current.packages.length > 0 ? `In ${current.packages.map((item) => item.name).join(', ')}` : 'Subscribe'}
              </Link>
            )}
            <FavoriteButton channel={current} onToggle={() => toggleFavorite(current)} />
          </div>
        ) : channelId ? (
          <p className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-600">This channel is not in the list for your region right now.</p>
        ) : null}
      </section>

      <section className="flex h-[70vh] min-h-0 flex-col gap-3 rounded-xl border border-line/5 bg-surface/80 p-3 lg:h-auto" aria-label="Channels">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search channels…"
            aria-label="Search channels"
            className="h-10 w-full rounded-lg bg-sunken/70 pl-9 pr-9 text-sm text-fg placeholder:text-fg-subtle ring-1 ring-inset ring-line/10 focus:outline-none focus:ring-2 focus:ring-brand"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-fg-muted hover:text-fg">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <label className="relative block min-w-0 flex-1">
            <span className="sr-only">Category</span>
            <ListFilter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <select value={filter} onChange={(event) => setFilter(event.target.value)} className="field appearance-none truncate pl-9">
              <option value="">All channels ({channels.length})</option>
              <option value={FAVORITES}>Favourites ({channels.filter((channel) => channel.favorite).length})</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
          {(query.data?.lineups.length ?? 0) > 0 && (
            <label className="block w-36 shrink-0">
              <span className="sr-only">Lineup</span>
              <select value={lineup ?? ''} onChange={(event) => setLineup(event.target.value || null)} className="field appearance-none truncate">
                <option value="">A–Z</option>
                {query.data!.lineups.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Channel list">
          {visible.length === 0 ? (
            <li className="py-12 text-center text-sm text-fg-muted">No channels match.</li>
          ) : (
            visible.map((channel) => (
              <li key={channel.id} className={cn('flex items-center gap-1 rounded-lg pr-1', channel.id === channelId ? 'bg-brand/15' : 'hover:bg-fg/5')}>
                <button
                  type="button"
                  onClick={() => navigate(paths.operatorChannel(channel.id))}
                  aria-current={channel.id === channelId ? 'true' : undefined}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  {channel.number !== null && <span className="w-8 shrink-0 text-right text-xs tabular-nums text-fg-subtle">{channel.number}</span>}
                  <ChannelLogo channel={channel} className="h-9 w-12" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
                      {channel.name}
                      {channel.locked && <Lock className="h-3 w-3 shrink-0 text-fg-subtle" aria-label="Needs a subscription" />}
                    </span>
                    {guide.data?.get(channel.id)?.now ? (
                      <span className="block truncate text-xs text-fg-subtle">{guide.data.get(channel.id)!.now!.title}</span>
                    ) : (
                      channel.category && <span className="block truncate text-xs text-fg-subtle">{channel.category}</span>
                    )}
                  </span>
                </button>
                <FavoriteButton channel={channel} onToggle={() => toggleFavorite(channel)} />
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function ChannelLogo({ channel, className }: { channel: OperatorChannelDto; className?: string }) {
  return <Img sources={imageSources(channel.logo)} fit="contain" className={cn('shrink-0 rounded-md bg-fg/5', className)} imgClassName="p-1" fallback={<Initials name={channel.name} />} />;
}

function FavoriteButton({ channel, onToggle }: { channel: OperatorChannelDto; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={channel.favorite}
      aria-label={channel.favorite ? `Remove ${channel.name} from favourites` : `Add ${channel.name} to favourites`}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:text-amber-400"
    >
      <Star className={cn('h-4 w-4', channel.favorite && 'fill-amber-400 text-amber-400')} />
    </button>
  );
}

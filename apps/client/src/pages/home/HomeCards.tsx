import type { HistoryItemDto, LiveNowItemDto, ProgressItemDto } from '@ziptv/contracts';
import { Play, X } from 'lucide-react';
import { Link } from 'react-router';

import { Img, Initials } from '../../components/ui/Img';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { programmeProgress } from '../../features/epg/programme';
import { ChannelLogo } from '../../features/live/components/ChannelLogo';
import { cn } from '../../lib/cn';
import { catalogImageProxy, imageSources } from '../../lib/images';
import { paths } from '../../lib/routes';
import { formatAgo, formatDuration } from '../../lib/time';

const CARD = 'group block w-60 shrink-0 snap-start rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand sm:w-72';

/** Continue Watching: resume straight into the player. */
export function ContinueCard({ item, onRemove }: { item: ProgressItemDto; onRemove: () => void }) {
  const to = item.contentType === 'episode' && item.seriesKey ? paths.playEpisode(item.sourceId, item.seriesKey, item.key) : paths.playMovie(item.sourceId, item.key);
  const label = item.contentType === 'episode' ? `${item.seriesTitle ?? ''}${item.season !== null ? ` · S${item.season} E${item.episode}` : ''}` : null;
  const imageType = item.contentType === 'episode' ? 'series' : 'movie';
  const imageKey = item.contentType === 'episode' && item.seriesKey ? item.seriesKey : item.key;
  return (
    <div role="listitem" className={cn(CARD, 'relative')}>
      <Link to={to} className="block" aria-label={`Resume ${item.title}`}>
        <div className="relative aspect-video overflow-hidden rounded-lg bg-fg/5 ring-1 ring-inset ring-line/5">
          <Img
            key={`${item.sourceId}:${item.key}`}
            sources={imageSources(item.image, catalogImageProxy(item.sourceId, imageType, imageKey))}
            className="h-full w-full transition-transform duration-300 group-hover:scale-[1.03]"
            fallback={<Initials name={item.seriesTitle ?? item.title} className="text-2xl" />}
          />
          <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100">
            <span className="rounded-full bg-brand p-3 text-white shadow-lg">
              <Play className="h-5 w-5 fill-current" />
            </span>
          </span>
          <ProgressBar value={item.duration > 0 ? item.position / item.duration : 0} className="absolute inset-x-2 bottom-2 w-auto bg-black/40" label={`${Math.round((item.position / Math.max(1, item.duration)) * 100)}% watched`} />
        </div>
        <p className="mt-1.5 truncate text-sm font-medium text-fg group-hover:text-brand-soft">{item.title}</p>
        <p className="truncate text-xs text-fg-subtle">{[label, `${formatDuration(item.remainingSecs)} left`].filter(Boolean).join(' · ')}</p>
      </Link>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${item.title} from Continue Watching`}
        className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1 text-white opacity-80 hover:bg-black/80 hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Live Now / Sports Live: channel + what is on, with programme progress. */
export function LiveTile({ item, now }: { item: LiveNowItemDto; now: number }) {
  return (
    <Link role="listitem" to={paths.channel(item.sourceId, item.channel.key)} className={cn(CARD, 'card p-3 hover:bg-fg/5')}>
      <div className="flex items-center gap-3">
        <ChannelLogo sourceId={item.sourceId} channel={item.channel} className="h-10 w-14" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg group-hover:text-brand-soft">{item.channel.name}</p>
          <p className="truncate text-xs text-fg-muted">{item.now?.title ?? 'On air'}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-live">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" /> Live
        </span>
      </div>
      {item.now && <ProgressBar value={programmeProgress(item.now, now)} tone="live" className="mt-2.5" />}
      {item.next && <p className="mt-1.5 truncate text-xs text-fg-subtle">Next: {item.next.title}</p>}
    </Link>
  );
}

/** Recently Watched: back to the channel / details of what was watched. */
export function RecentCard({ item, now }: { item: HistoryItemDto; now: number }) {
  const to =
    item.contentType === 'movie'
      ? paths.movie(item.sourceId, item.key)
      : item.contentType === 'episode' && item.seriesKey
        ? paths.series(item.sourceId, item.seriesKey)
        : paths.channel(item.sourceId, item.key);
  const channel = item.contentType === 'channel' || item.contentType === 'catchup';
  const imageType = channel ? 'channel' : item.contentType === 'movie' ? 'movie' : 'series';
  const imageKey = item.contentType === 'episode' && item.seriesKey ? item.seriesKey : item.key;
  return (
    <Link role="listitem" to={to} className={cn(CARD, 'w-40 sm:w-44')} title={item.title}>
      <div className="relative aspect-video overflow-hidden rounded-lg bg-fg/5 ring-1 ring-inset ring-line/5">
        <Img
          key={item.id}
          sources={imageSources(item.image, catalogImageProxy(item.sourceId, imageType, imageKey))}
          fit={channel ? 'contain' : 'cover'}
          imgClassName={channel ? 'p-3' : undefined}
          className="h-full w-full"
          fallback={<Initials name={item.title} className="text-xl" />}
        />
      </div>
      <p className="mt-1.5 truncate text-sm font-medium text-fg group-hover:text-brand-soft">{item.title}</p>
      <p className="truncate text-xs text-fg-subtle">{[item.subtitle, formatAgo(item.watchedAt, now)].filter(Boolean).join(' · ')}</p>
    </Link>
  );
}

import type { EpisodeDto, SeriesDetailsDto } from '@ziptv/contracts';
import { Check, Play, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Img } from '../../components/ui/Img';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { Spinner } from '../../components/ui/Spinner';
import { ListToggle } from '../../features/user-state/components/ListToggle';
import { useSeriesDetails } from '../../features/vod/api';
import { errorMessage } from '../../lib/api-client';
import { cn } from '../../lib/cn';
import { imageSources } from '../../lib/images';
import { paths } from '../../lib/routes';
import { formatDuration } from '../../lib/time';
import { DetailsHeader } from './DetailsHeader';

/** /series/:sourceId/:key — seasons and episodes (Xtream episodes load on first open). */
export function SeriesDetailsPage() {
  const { sourceId, key } = useParams();
  const series = useSeriesDetails(sourceId, key);
  const [season, setSeason] = useState<number | null>(null);
  if (series.isPending) return <Spinner className="justify-center py-24" label="Loading episodes…" />;
  if (series.isError) return <div className="p-6"><EmptyState title="Series not available" description={errorMessage(series.error)} /></div>;
  const data = series.data;
  const first = data.seasons[0]?.episodes[0];
  const resume = data.resume;
  const activeSeason = data.seasons.find((item) => item.number === (season ?? resume?.season ?? data.seasons[0]?.number)) ?? data.seasons[0];
  const playTarget = resume?.episodeKey ?? first?.key;
  const episodes = data.seasons.reduce((total, item) => total + item.episodes.length, 0);

  return (
    <DetailsHeader
      sourceId={data.sourceId}
      type="series"
      itemKey={data.key}
      title={data.name}
      image={data.cover}
      meta={[data.year ? String(data.year) : null, data.rating ? `★ ${data.rating.toFixed(1)}` : null, data.seasons.length ? `${data.seasons.length} season${data.seasons.length === 1 ? '' : 's'} · ${episodes} episodes` : null]}
      genres={data.genres}
      plot={data.plot}
      locked={data.locked}
      actions={
        <>
          {playTarget && (
            <Link to={paths.playEpisode(data.sourceId, data.key, playTarget)}>
              <Button variant="primary" icon={resume ? <RotateCcw className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}>
                {resume ? `${resume.position > 0 ? 'Resume' : 'Play'} S${resume.season} E${resume.episode}` : 'Play'}
              </Button>
            </Link>
          )}
          <ListToggle type="series" sourceId={data.sourceId} itemKey={data.key} initial={data.inMyList} />
        </>
      }
    >
      {data.seasons.length === 0 ? (
        <EmptyState className="mt-6" title="No episodes yet" description="The provider did not list any episodes for this series." />
      ) : (
        <div className="mt-6">
          {data.seasons.length > 1 && (
            <div role="tablist" aria-label="Seasons" className="no-scrollbar mb-3 flex gap-2 overflow-x-auto">
              {data.seasons.map((item) => (
                <button
                  key={item.number}
                  type="button"
                  role="tab"
                  aria-selected={item.number === activeSeason?.number}
                  onClick={() => setSeason(item.number)}
                  className={cn(
                    'shrink-0 rounded-full px-3 py-1.5 text-sm ring-1 ring-inset',
                    item.number === activeSeason?.number ? 'bg-brand text-white ring-brand' : 'text-fg-muted ring-line/10 hover:bg-fg/5',
                  )}
                >
                  {item.name}
                </button>
              ))}
            </div>
          )}
          <ol className="space-y-2" aria-label={activeSeason?.name}>
            {activeSeason?.episodes.map((episode) => (
              <EpisodeRow key={episode.key} series={data} episode={episode} current={episode.key === resume?.episodeKey} />
            ))}
          </ol>
        </div>
      )}
    </DetailsHeader>
  );
}

function EpisodeRow({ series, episode, current }: { series: SeriesDetailsDto; episode: EpisodeDto; current: boolean }) {
  const progress = episode.progress;
  return (
    <li>
      <Link
        to={paths.playEpisode(series.sourceId, series.key, episode.key)}
        className={cn('card flex items-center gap-3 p-2.5 hover:bg-fg/5', current && 'ring-1 ring-brand/50')}
        aria-label={`Play episode ${episode.episode}: ${episode.title}`}
      >
        <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-md bg-fg/5 sm:w-36">
          <Img sources={imageSources(episode.still)} className="h-full w-full" fallback={<span className="flex h-full items-center justify-center text-lg font-semibold text-fg-subtle">E{episode.episode}</span>} />
          {progress && !progress.completed && <ProgressBar value={progress.position / Math.max(1, progress.duration)} className="absolute inset-x-1 bottom-1 w-auto bg-black/40" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">
            {episode.episode}. {episode.title}
          </p>
          <p className="text-xs text-fg-subtle">{[formatDuration(episode.durationSecs), episode.airDate].filter(Boolean).join(' · ')}</p>
          {episode.plot && <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{episode.plot}</p>}
        </div>
        {progress?.completed ? <Check className="h-4 w-4 shrink-0 text-emerald-500" aria-label="Watched" /> : <Play className="h-4 w-4 shrink-0 text-fg-subtle" />}
      </Link>
    </li>
  );
}

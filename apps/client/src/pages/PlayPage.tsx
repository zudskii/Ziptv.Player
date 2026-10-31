import type { ContentRefDto } from '@ziptv/contracts';
import { ArrowLeft } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';

import { IconButton } from '../components/ui/Button';
import { VideoPlayer } from '../features/player/components/VideoPlayer';
import { useSettings } from '../features/user-state/api';
import { useMovieDetails, useSeriesDetails } from '../features/vod/api';
import { paths } from '../lib/routes';

/** /play/movie/:sourceId/:key and /play/episode/:sourceId/:seriesKey/:key — the VOD player. */
export function PlayPage({ type }: { type: 'movie' | 'episode' }) {
  const { sourceId, seriesKey, key } = useParams();
  const navigate = useNavigate();
  const settings = useSettings().data;
  const movie = useMovieDetails(type === 'movie' ? sourceId : undefined, key);
  const series = useSeriesDetails(type === 'episode' ? sourceId : undefined, seriesKey);

  const content = useMemo<ContentRefDto | undefined>(() => {
    if (!sourceId || !key) return undefined;
    return type === 'episode' && seriesKey ? { type: 'episode', sourceId, seriesKey, key } : { type: 'movie', sourceId, key };
  }, [type, sourceId, seriesKey, key]);

  const episodes = series.data?.seasons.flatMap((season) => season.episodes) ?? [];
  const index = episodes.findIndex((episode) => episode.key === key);
  const episode = index >= 0 ? episodes[index] : undefined;
  const next = index >= 0 ? episodes[index + 1] : undefined;
  const title = type === 'movie' ? (movie.data?.name ?? 'Movie') : (episode?.title ?? 'Episode');
  const subtitle = type === 'movie' ? (movie.data?.year ? String(movie.data.year) : null) : series.data && episode ? `${series.data.name} · S${episode.season} E${episode.episode}` : null;
  const goNext = next && sourceId && seriesKey ? () => navigate(paths.playEpisode(sourceId, seriesKey, next.key), { replace: true }) : undefined;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3 p-2 sm:p-4">
      <div className="flex items-center gap-2">
        <IconButton label="Back" onClick={() => navigate(type === 'movie' && sourceId && key ? paths.movie(sourceId, key) : sourceId && seriesKey ? paths.series(sourceId, seriesKey) : '/')}>
          <ArrowLeft className="h-5 w-5" />
        </IconButton>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-fg">{title}</h1>
          {subtitle && <p className="truncate text-sm text-fg-muted">{subtitle}</p>}
        </div>
      </div>
      <VideoPlayer
        content={content}
        title={title}
        onNext={goNext}
        nextLabel="Next episode"
        upNext={next ? { title: next.title, subtitle: `S${next.season} E${next.episode}`, autoplay: settings?.playback.autoplayNextEpisode ?? true } : null}
      />
    </div>
  );
}

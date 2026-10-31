import { Play, RotateCcw } from 'lucide-react';
import { Link, useParams } from 'react-router';

import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { Spinner } from '../../components/ui/Spinner';
import { ListToggle } from '../../features/user-state/components/ListToggle';
import { useMovieDetails } from '../../features/vod/api';
import { errorMessage } from '../../lib/api-client';
import { paths } from '../../lib/routes';
import { formatDuration } from '../../lib/time';
import { DetailsHeader } from './DetailsHeader';

/** /movies/:sourceId/:key */
export function MovieDetailsPage() {
  const { sourceId, key } = useParams();
  const movie = useMovieDetails(sourceId, key);
  if (movie.isPending) return <Spinner className="justify-center py-24" label="Loading…" />;
  if (movie.isError) return <div className="p-6"><EmptyState title="Movie not available" description={errorMessage(movie.error)} /></div>;
  const data = movie.data;
  const progress = data.progress && !data.progress.completed && data.progress.position > 0 ? data.progress : null;
  return (
    <DetailsHeader
      sourceId={data.sourceId}
      type="movie"
      itemKey={data.key}
      title={data.name}
      image={data.poster}
      meta={[data.year ? String(data.year) : null, data.rating ? `★ ${data.rating.toFixed(1)}` : null, formatDuration(data.durationSecs) || null, data.groups[0]]}
      genres={data.genres}
      plot={data.plot}
      locked={data.locked}
      actions={
        <>
          <Link to={paths.playMovie(data.sourceId, data.key)}>
            <Button variant="primary" icon={progress ? <RotateCcw className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}>
              {progress ? 'Resume' : 'Play'}
            </Button>
          </Link>
          <ListToggle type="movie" sourceId={data.sourceId} itemKey={data.key} initial={data.inMyList} />
        </>
      }
    >
      {progress && (
        <div className="mt-4 max-w-xs">
          <ProgressBar value={progress.position / Math.max(1, progress.duration)} />
          <p className="mt-1 text-xs text-fg-subtle">{formatDuration(progress.duration - progress.position)} left</p>
        </div>
      )}
    </DetailsHeader>
  );
}

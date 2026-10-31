import type { HomeDto } from '@ziptv/contracts';
import { AlertTriangle, Clapperboard, LoaderCircle } from 'lucide-react';
import { useEffect } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { PosterCard } from '../components/media/PosterCard';
import { Rail } from '../components/media/Rail';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { useSources } from '../features/sources/api';
import { useHome, useRemoveProgress, useSettings } from '../features/user-state/api';
import { errorMessage } from '../lib/api-client';
import { itemPath, paths } from '../lib/routes';
import { useNow } from '../lib/use-now';
import { ContinueCard, LiveTile, RecentCard } from './home/HomeCards';

const TYPE_LABELS = { channel: 'Channel', movie: 'Movie', series: 'Series' } as const;
const START_PATHS = { home: '/', live: '/live', guide: '/guide', movies: '/movies', series: '/series' } as const;

// Settings → General → Start page applies when the app is opened at "/", once per page load.
const openedAtRoot = typeof window !== 'undefined' && window.location.pathname === '/';
let startPageHandled = false;

function useStartPage(): void {
  const navigate = useNavigate();
  const startPage = useSettings().data?.general.startPage;
  useEffect(() => {
    if (startPageHandled || !startPage) return;
    startPageHandled = true;
    if (openedAtRoot && startPage !== 'home') navigate(START_PATHS[startPage], { replace: true });
  }, [startPage, navigate]);
}

/** Home: every rail from GET /home; empty rails are hidden, and an empty library explains itself. */
export function HomePage() {
  const sources = useSources();
  const home = useHome();
  const now = useNow(30_000);
  const removeProgress = useRemoveProgress();
  useStartPage();

  if (sources.data && sources.data.length === 0) return <Navigate to="/welcome" replace />;
  if (home.isPending) return <Spinner className="py-24 justify-center" label="Loading your home…" />;
  if (home.isError) {
    return (
      <div className="p-4 sm:p-6">
        <EmptyState icon={<AlertTriangle className="h-8 w-8" />} title="Home could not be loaded" description={errorMessage(home.error)} />
      </div>
    );
  }
  const data = home.data;
  const empty = isEmpty(data);

  return (
    <div className="space-y-7 py-4 sm:py-6">
      <header className="px-4 sm:px-6">
        <h1 className="text-2xl font-bold text-fg">Home</h1>
      </header>
      <LibraryNotice data={data} />

      {data.continueWatching.length > 0 && (
        <Rail title="Continue watching">
          {data.continueWatching.map((item) => (
            <ContinueCard
              key={`${item.sourceId}:${item.seriesKey ?? ''}:${item.key}`}
              item={item}
              onRemove={() =>
                removeProgress.mutate(item, { onError: (error) => toast.error(errorMessage(error)) })
              }
            />
          ))}
        </Rail>
      )}
      {data.liveNow.length > 0 && (
        <Rail title="Live now" to="/guide">
          {data.liveNow.map((item) => (
            <LiveTile key={`${item.sourceId}:${item.channel.key}`} item={item} now={now} />
          ))}
        </Rail>
      )}
      {data.favorites.length > 0 && (
        <Rail title="My List" to="/my-list">
          {data.favorites.map((item) => (
            <PosterCard key={`${item.sourceId}:${item.type}:${item.key}`} to={itemPath(item)} sourceId={item.sourceId} type={item.type} itemKey={item.key} title={item.title} image={item.image} subtitle={item.subtitle} />
          ))}
        </Rail>
      )}
      {data.recentlyWatched.length > 0 && (
        <Rail title="Recently watched" to="/history">
          {data.recentlyWatched.map((item) => (
            <RecentCard key={item.id} item={item} now={now} />
          ))}
        </Rail>
      )}
      {data.sportsLive.length > 0 && (
        <Rail title="Sports live">
          {data.sportsLive.map((item) => (
            <LiveTile key={`${item.sourceId}:${item.channel.key}`} item={item} now={now} />
          ))}
        </Rail>
      )}
      {data.movies.length > 0 && (
        <Rail title="Movies" to="/movies">
          {data.movies.map((movie) => (
            <PosterCard key={`${movie.sourceId}:${movie.key}`} to={paths.movie(movie.sourceId, movie.key)} sourceId={movie.sourceId} type="movie" itemKey={movie.key} title={movie.name} image={movie.poster} subtitle={movie.year ? String(movie.year) : (movie.groups[0] ?? null)} locked={movie.locked} />
          ))}
        </Rail>
      )}
      {data.series.length > 0 && (
        <Rail title="Series" to="/series">
          {data.series.map((series) => (
            <PosterCard key={`${series.sourceId}:${series.key}`} to={paths.series(series.sourceId, series.key)} sourceId={series.sourceId} type="series" itemKey={series.key} title={series.name} image={series.cover} subtitle={series.year ? String(series.year) : (series.groups[0] ?? null)} locked={series.locked} />
          ))}
        </Rail>
      )}
      {data.recentlyAdded.length > 0 && (
        <Rail title="Recently added">
          {data.recentlyAdded.map((item) => (
            <PosterCard
              key={`${item.sourceId}:${item.type}:${item.key}`}
              to={itemPath(item)}
              sourceId={item.sourceId}
              type={item.type}
              itemKey={item.key}
              title={item.title}
              image={item.image}
              badge={<Badge tone="brand">{TYPE_LABELS[item.type]}</Badge>}
            />
          ))}
        </Rail>
      )}

      {empty && (
        <div className="px-4 sm:px-6">
          <EmptyState
            icon={<Clapperboard className="h-8 w-8" />}
            title="Nothing here yet"
            description="Start a channel, a movie or a series — what you watch, save to My List and leave halfway shows up here."
            action={
              <Link to="/live" className="text-sm font-medium text-brand-soft hover:underline">
                Open Live TV
              </Link>
            }
          />
        </div>
      )}
    </div>
  );
}

/** Explains empty rails: sources still loading or failing. */
function LibraryNotice({ data }: { data: HomeDto }) {
  const loading = data.sources.filter((source) => source.revision === 0 && source.sync.status !== 'failed');
  const failed = data.sources.filter((source) => source.sync.status === 'failed');
  if (loading.length === 0 && failed.length === 0) return null;
  return (
    <div className="px-4 sm:px-6">
      <Link to="/sources" className="card flex items-center gap-3 p-3 text-sm hover:bg-fg/5">
        {loading.length > 0 ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-brand-soft" /> : <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />}
        <span className="min-w-0 flex-1 text-fg-muted">
          {loading.length > 0
            ? `${loading.map((source) => source.name).join(', ')} ${loading.length === 1 ? 'is' : 'are'} still loading — rails fill in as soon as the library is ready.`
            : `${failed.map((source) => source.name).join(', ')} could not be updated. Open Sources for details.`}
        </span>
      </Link>
    </div>
  );
}

function isEmpty(data: HomeDto): boolean {
  return [data.continueWatching, data.liveNow, data.favorites, data.recentlyWatched, data.sportsLive, data.movies, data.series, data.recentlyAdded].every((rail) => rail.length === 0);
}

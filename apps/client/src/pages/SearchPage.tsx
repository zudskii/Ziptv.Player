import { Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';

import { Rail } from '../components/media/Rail';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { ChannelLogo } from '../features/live/components/ChannelLogo';
import { useSearch } from '../features/user-state/api';
import { errorMessage } from '../lib/api-client';
import { paths } from '../lib/routes';
import { formatDay, formatRange } from '../lib/time';
import { VodCard } from './vod/VodBrowsePage';

/** /search?q= — channels, movies, series and programmes across every source. */
export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const search = useSearch(q);
  const data = search.data;
  const total = data ? data.channels.length + data.movies.length + data.series.length + data.programmes.length : 0;

  return (
    <div className="space-y-6 py-4 sm:py-6">
      <header className="px-4 sm:px-6">
        <h1 className="text-2xl font-bold text-fg">Search</h1>
        {q.trim().length >= 2 && <p className="text-sm text-fg-muted">Results for “{q.trim()}”</p>}
      </header>
      {q.trim().length < 2 ? (
        <div className="px-4 sm:px-6">
          <EmptyState icon={<Search className="h-8 w-8" />} title="Search everything" description="Type at least two letters in the search box: channels, movies, series and programmes from all your sources." />
        </div>
      ) : search.isPending ? (
        <Spinner className="px-6" label="Searching…" />
      ) : search.isError ? (
        <div className="px-4 sm:px-6">
          <EmptyState title="Search failed" description={errorMessage(search.error)} />
        </div>
      ) : total === 0 ? (
        <div className="px-4 sm:px-6">
          <EmptyState icon={<Search className="h-8 w-8" />} title="No results" description="Try fewer or different words — names are matched by the start of each word." />
        </div>
      ) : (
        <>
          {data!.channels.length > 0 && (
            <Rail title={`Channels · ${data!.channels.length}`}>
              {data!.channels.map(({ sourceId, sourceName, channel }) => (
                <Link role="listitem" key={`${sourceId}:${channel.key}`} to={paths.channel(sourceId, channel.key)} className="card flex w-56 shrink-0 snap-start items-center gap-3 p-3 hover:bg-fg/5">
                  <ChannelLogo sourceId={sourceId} channel={channel} className="h-10 w-14" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-fg">{channel.name}</span>
                    <span className="block truncate text-xs text-fg-subtle">{[channel.groups[0], sourceName].filter(Boolean).join(' · ')}</span>
                  </span>
                </Link>
              ))}
            </Rail>
          )}
          {data!.movies.length > 0 && (
            <Rail title={`Movies · ${data!.movies.length}`}>
              {data!.movies.map((movie) => (
                <VodCard key={`${movie.sourceId}:${movie.key}`} item={movie} />
              ))}
            </Rail>
          )}
          {data!.series.length > 0 && (
            <Rail title={`Series · ${data!.series.length}`}>
              {data!.series.map((series) => (
                <VodCard key={`${series.sourceId}:${series.key}`} item={series} />
              ))}
            </Rail>
          )}
          {data!.programmes.length > 0 && (
            <section className="px-4 sm:px-6" aria-label="Programmes">
              <h2 className="mb-2 text-base font-semibold text-fg sm:text-lg">Programmes · {data!.programmes.length}</h2>
              <ul className="space-y-2">
                {data!.programmes.map(({ sourceId, channel, programme }) => (
                  <li key={`${sourceId}:${channel.key}:${programme.id}`}>
                    <Link to={paths.channel(sourceId, channel.key)} className="card flex items-center gap-3 p-2.5 hover:bg-fg/5">
                      <ChannelLogo sourceId={sourceId} channel={channel} className="h-9 w-12" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-fg">{programme.title}</span>
                        <span className="block truncate text-xs text-fg-subtle">
                          {channel.name} · {formatDay(programme.start)} {formatRange(programme.start, programme.end)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

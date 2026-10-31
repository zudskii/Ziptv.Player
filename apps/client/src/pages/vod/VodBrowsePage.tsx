import type { SourceDto, VodSort } from '@ziptv/contracts';
import { Clapperboard, MonitorPlay, Server } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';

import { PosterCard } from '../../components/media/PosterCard';
import { Rail } from '../../components/media/Rail';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { useSources } from '../../features/sources/api';
import { isMovie, useVodList, useVodOverview, type VodItem, type VodKind } from '../../features/vod/api';
import { errorMessage } from '../../lib/api-client';
import { cn } from '../../lib/cn';
import { paths } from '../../lib/routes';

const SORTS: { value: VodSort; label: string }[] = [
  { value: 'recent', label: 'Recently added' },
  { value: 'name', label: 'A–Z' },
  { value: 'rating', label: 'Rating' },
  { value: 'year', label: 'Year' },
];

const COPY = {
  movies: { title: 'Movies', all: 'All movies', empty: 'No movies yet', icon: Clapperboard, list: paths.movies },
  series: { title: 'Series', all: 'All series', empty: 'No series yet', icon: MonitorPlay, list: paths.seriesList },
} as const;

/** /movies[/:sourceId] and /series[/:sourceId]: rails + categories + a sortable, paged grid. */
export function VodBrowsePage({ kind }: { kind: VodKind }) {
  const { sourceId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const copy = COPY[kind];
  const sources = useSources();
  const withItems = (sources.data ?? []).filter((source) => source.revision > 0 && (kind === 'movies' ? source.stats.movies : source.stats.series) > 0);
  const source = withItems.find((item) => item.id === sourceId) ?? withItems[0];
  const category = params.get('category');
  const sort = (SORTS.some((option) => option.value === params.get('sort')) ? params.get('sort') : 'recent') as VodSort;
  const browsing = Boolean(category) || sort !== 'recent';

  useEffect(() => {
    if (source && source.id !== sourceId) navigate(`${copy.list(source.id)}${params.size ? `?${params.toString()}` : ''}`, { replace: true });
  }, [source, sourceId, navigate, copy, params]);

  const overview = useVodOverview(source?.id, kind);
  const list = useVodList(source?.id, kind, { category, sort });

  if (sources.isPending) return <Spinner className="justify-center py-24" label="Loading…" />;
  if (sources.data && sources.data.length === 0) return <Navigate to="/welcome" replace />;
  if (!source) {
    return (
      <div className="p-4 sm:p-6">
        <h1 className="mb-4 text-2xl font-bold text-fg">{copy.title}</h1>
        <EmptyState
          icon={<copy.icon className="h-8 w-8" />}
          title={copy.empty}
          description="Movies and series come from Xtream Codes accounts and from playlists that contain VOD. Add or switch a source to see them here."
          action={
            <Link to="/sources">
              <Button icon={<Server className="h-4 w-4" />}>Sources</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const update = (next: { category?: string | null; sort?: VodSort }) => {
    const search = new URLSearchParams(params);
    if (next.category !== undefined) {
      if (next.category) search.set('category', next.category);
      else search.delete('category');
    }
    if (next.sort !== undefined) {
      if (next.sort === 'recent') search.delete('sort');
      else search.set('sort', next.sort);
    }
    setParams(search);
  };
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const total = list.data?.pages[0]?.total;

  return (
    <div className="space-y-5 py-4 sm:py-6">
      <header className="flex flex-wrap items-center gap-3 px-4 sm:px-6">
        <h1 className="text-2xl font-bold text-fg">{copy.title}</h1>
        {withItems.length > 1 && <SourcePicker sources={withItems} value={source.id} onChange={(id) => navigate(copy.list(id))} />}
        <label className="ml-auto flex items-center gap-2 text-sm text-fg-muted">
          Sort
          <select className="field h-9 w-auto" value={sort} onChange={(event) => update({ sort: event.target.value as VodSort })} aria-label="Sort">
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      {overview.data && overview.data.categories.length > 0 && (
        <nav aria-label="Categories" className="no-scrollbar flex gap-2 overflow-x-auto px-4 sm:px-6">
          <Chip active={!category} onClick={() => update({ category: null })}>
            All
          </Chip>
          {overview.data.categories.map((item) => (
            <Chip key={item.name} active={category === item.name} onClick={() => update({ category: item.name })}>
              {item.name} <span className="text-fg-subtle">{item.count}</span>
            </Chip>
          ))}
        </nav>
      )}

      {!browsing &&
        overview.data?.rails.map((rail) => (
          <Rail key={rail.id} title={rail.title} {...(rail.category ? { to: copy.list(source.id, rail.category) } : {})}>
            {rail.items.map((item) => (
              <VodCard key={item.key} item={item} />
            ))}
          </Rail>
        ))}

      <section className="px-4 sm:px-6" aria-label={category ?? copy.all}>
        <h2 className="mb-3 text-base font-semibold text-fg sm:text-lg">
          {category ?? copy.all}
          {total !== undefined && <span className="ml-2 text-sm font-normal text-fg-subtle">{total.toLocaleString()}</span>}
        </h2>
        {list.isPending ? (
          <Spinner label="Loading…" />
        ) : list.isError ? (
          <EmptyState title="Could not load this list" description={errorMessage(list.error)} />
        ) : items.length === 0 ? (
          <EmptyState title="Nothing in this category" />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-3 gap-y-5 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
            {items.map((item) => (
              <VodCard key={item.key} item={item} layout="grid" />
            ))}
          </div>
        )}
        {list.hasNextPage && <LoadMore loading={list.isFetchingNextPage} onLoad={() => void list.fetchNextPage()} />}
      </section>
    </div>
  );
}

export function VodCard({ item, layout = 'rail' }: { item: VodItem; layout?: 'rail' | 'grid' }) {
  const movie = isMovie(item);
  return (
    <PosterCard
      layout={layout}
      to={movie ? paths.movie(item.sourceId, item.key) : paths.series(item.sourceId, item.key)}
      sourceId={item.sourceId}
      type={movie ? 'movie' : 'series'}
      itemKey={item.key}
      title={item.name}
      image={movie ? item.poster : item.cover}
      subtitle={[item.year, item.rating ? `★ ${item.rating.toFixed(1)}` : null].filter(Boolean).join(' · ') || null}
      locked={item.locked}
    />
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn('shrink-0 rounded-full px-3 py-1.5 text-sm ring-1 ring-inset transition-colors', active ? 'bg-brand text-white ring-brand' : 'text-fg-muted ring-line/10 hover:bg-fg/5 hover:text-fg')}
    >
      {children}
    </button>
  );
}

function SourcePicker({ sources, value, onChange }: { sources: SourceDto[]; value: string; onChange: (id: string) => void }) {
  return (
    <select className="field h-9 w-auto max-w-[12rem]" value={value} onChange={(event) => onChange(event.target.value)} aria-label="Source">
      {sources.map((source) => (
        <option key={source.id} value={source.id}>
          {source.name}
        </option>
      ))}
    </select>
  );
}

/** Loads the next page when scrolled into view (and on click, for keyboards / old browsers). */
export function LoadMore({ loading, onLoad }: { loading: boolean; onLoad: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(onLoad);
  const busy = useRef(loading);
  useEffect(() => {
    latest.current = onLoad;
    busy.current = loading;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => !busy.current && entries.some((entry) => entry.isIntersecting) && latest.current(), { rootMargin: '400px' });
    observer.observe(element);
    return () => observer.disconnect();
    // Re-observing after each page fires again while the button is still in view.
  }, [loading]);
  return (
    <div ref={ref} className="mt-6 flex justify-center">
      <Button onClick={onLoad} loading={loading}>
        Load more
      </Button>
    </div>
  );
}

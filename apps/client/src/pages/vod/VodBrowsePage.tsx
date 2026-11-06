import type { SourceDto, VodSort } from '@ziptv/contracts';
import { Clapperboard, MonitorPlay, Server, SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { PosterCard } from '../../components/media/PosterCard';
import { Rail } from '../../components/media/Rail';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { useSources } from '../../features/sources/api';
import { isMovie, useVodList, useVodOverview, type VodItem, type VodKind } from '../../features/vod/api';
import { activeFilterCount, readFilters, useVodBrowse, writeFilters, type VodFilters } from '../../features/vod/filters';
import { ActiveFilters, VodFilterPanel } from '../../features/vod/VodFilterPanel';
import { errorMessage } from '../../lib/api-client';
import { cn } from '../../lib/cn';
import { paths } from '../../lib/routes';
import { NoSourcesState } from '../../features/sources/components/NoSourcesState';
import { t } from '../../i18n';

const SORTS: { readonly value: VodSort; readonly label: string }[] = (['recent', 'name', 'rating', 'year'] as const).map((value) => ({
  value,
  get label() {
    return t(`vod.sort.${value}`);
  },
}));

/** Labels are getters: read when shown, in the current language. */
const copyFor = (kind: 'movies' | 'series', icon: typeof Clapperboard, list: typeof paths.movies) => ({
  get title() {
    return t(`vod.${kind}.title`);
  },
  get all() {
    return t(`vod.${kind}.all`);
  },
  get empty() {
    return t(`vod.${kind}.empty`);
  },
  icon,
  list,
});

const COPY = {
  movies: copyFor('movies', Clapperboard, paths.movies),
  series: copyFor('series', MonitorPlay, paths.seriesList),
};

/**
 * /movies[/:sourceId] and /series[/:sourceId]: rails + categories + a sortable, paged grid of one
 * source — or, with filters, one filtered grid across the whole library (state in the URL).
 */
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
  const filters = readFilters(params, kind);
  const filtering = activeFilterCount(filters) > 0;
  // Closed by default: the active filters show as chips; the panel opens on demand.
  const [panelOpen, setPanelOpen] = useState(false);
  const filtered = useVodBrowse(kind, filters, sort, filtering || panelOpen);

  useEffect(() => {
    if (source && source.id !== sourceId) navigate(`${copy.list(source.id)}${params.size ? `?${params.toString()}` : ''}`, { replace: true });
  }, [source, sourceId, navigate, copy, params]);

  const overview = useVodOverview(source?.id, kind);
  const list = useVodList(source?.id, kind, { category, sort }, !filtering);

  if (sources.isPending) return <Spinner className="justify-center py-24" label={t('vod.loading')} />;
  if (sources.data && sources.data.length === 0) return <NoSourcesState area={kind} />;
  if (!source) {
    return (
      <div className="p-4 sm:p-6">
        <h1 className="mb-4 text-2xl font-bold text-fg">{copy.title}</h1>
        <EmptyState
          icon={<copy.icon className="h-8 w-8" />}
          title={copy.empty}
          description={t('vod.emptyHint')}
          action={
            <Link to="/sources">
              <Button icon={<Server className="h-4 w-4" />}>{t('vod.sources')}</Button>
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
  const setFilters = (next: VodFilters) => {
    // Filtering covers the whole library: the per-source category no longer applies.
    const search = writeFilters(params, next);
    if (activeFilterCount(next) > 0) search.delete('category');
    setParams(search, { replace: true });
  };
  const current = filtering ? filtered : list;
  const items = current.data?.pages.flatMap((page) => page.items) ?? [];
  const total = current.data?.pages[0]?.total;
  const facets = filtered.data?.pages[0]?.facets;
  const heading = filtering ? t('vod.filters.results') : (category ?? copy.all);

  return (
    <div className="space-y-5 py-4 sm:py-6">
      <header className="flex flex-wrap items-center gap-3 px-4 sm:px-6">
        <h1 className="text-2xl font-bold text-fg">{copy.title}</h1>
        {withItems.length > 1 && !filtering && <SourcePicker sources={withItems} value={source.id} onChange={(id) => navigate(`${copy.list(id)}${params.size ? `?${params.toString()}` : ''}`)} />}
        <Button
          size="sm"
          className="ml-auto"
          icon={<SlidersHorizontal className="h-4 w-4" />}
          aria-expanded={panelOpen}
          aria-controls="vod-filters"
          variant={filtering ? 'primary' : 'secondary'}
          onClick={() => setPanelOpen((open) => !open)}
        >
          {filtering ? t('vod.filters.buttonActive', { count: activeFilterCount(filters) }) : t('vod.filters.button')}
        </Button>
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          {t('vod.sortLabel')}
          <select className="field h-9 w-auto" value={sort} onChange={(event) => update({ sort: event.target.value as VodSort })} aria-label={t('vod.sortLabel')}>
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      {panelOpen && (
        <div id="vod-filters" className="px-4 sm:px-6">
          <VodFilterPanel kind={kind} filters={filters} onChange={setFilters} facets={facets} sources={withItems} />
        </div>
      )}
      {filtering && (
        <div className="px-4 sm:px-6">
          <ActiveFilters kind={kind} filters={filters} onChange={setFilters} sources={withItems} />
        </div>
      )}

      {!filtering && overview.data && overview.data.categories.length > 0 && (
        <nav aria-label={t('vod.categories')} className="no-scrollbar flex gap-2 overflow-x-auto px-4 sm:px-6">
          <Chip active={!category} onClick={() => update({ category: null })}>
            {t('vod.all')}
          </Chip>
          {overview.data.categories.map((item) => (
            <Chip key={item.name} active={category === item.name} onClick={() => update({ category: item.name })}>
              {item.name} <span className="text-fg-subtle">{item.count}</span>
            </Chip>
          ))}
        </nav>
      )}

      {!browsing &&
        !filtering &&
        overview.data?.rails.map((rail) => (
          <Rail key={rail.id} title={rail.title} {...(rail.category ? { to: copy.list(source.id, rail.category) } : {})}>
            {rail.items.map((item) => (
              <VodCard key={item.key} item={item} />
            ))}
          </Rail>
        ))}

      <section className="px-4 sm:px-6" aria-label={heading} aria-busy={current.isFetching && !current.isFetchingNextPage}>
        <h2 className="mb-3 text-base font-semibold text-fg sm:text-lg">
          {heading}
          {total !== undefined && <span className="ml-2 text-sm font-normal text-fg-subtle">{total.toLocaleString()}</span>}
        </h2>
        {current.isPending ? (
          <Spinner label={t('vod.loading')} />
        ) : current.isError ? (
          <EmptyState tone="error" title={t('vod.listFailed')} description={errorMessage(current.error)} onRetry={() => void current.refetch()} />
        ) : items.length === 0 ? (
          filtering ? (
            <EmptyState
              title={t('vod.filters.noResults')}
              description={t('vod.filters.noResultsHint')}
              action={
                <Button size="sm" onClick={() => setFilters({ genres: [], decade: null, rating: null, length: null, added: null, watch: null, sources: [], q: '' })}>
                  {t('vod.filters.clear')}
                </Button>
              }
            />
          ) : (
            <EmptyState title={t('vod.emptyCategory')} />
          )
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-3 gap-y-5 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
            {items.map((item) => (
              <VodCard key={`${item.sourceId}:${item.key}`} item={item} layout="grid" />
            ))}
          </div>
        )}
        {current.hasNextPage && <LoadMore loading={current.isFetchingNextPage} onLoad={() => void current.fetchNextPage()} />}
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
    <select className="field h-9 w-auto max-w-[12rem]" value={value} onChange={(event) => onChange(event.target.value)} aria-label={t('vod.source')}>
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
        {t('vod.loadMore')}
      </Button>
    </div>
  );
}

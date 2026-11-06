import type { SourceDto, VodFacetsDto } from '@ziptv/contracts';
import { Search, X } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';

import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { ADDED_DAYS, GENRES, LENGTHS, RATINGS, WATCH, type VodFilters } from './filters';
import type { VodKind } from './api';

interface PanelProps {
  kind: VodKind;
  filters: VodFilters;
  onChange: (filters: VodFilters) => void;
  /** Counts for each choice with the other filters applied (absent while loading). */
  facets: VodFacetsDto | undefined;
  sources: SourceDto[];
}

/**
 * The filter panel of Movies / Series. Every choice shows how many items it would give with the
 * other filters as they are; choices that would give nothing are dimmed (still selectable when
 * already selected, so they can be turned off).
 */
export function VodFilterPanel({ kind, filters, onChange, facets, sources }: PanelProps) {
  const set = (patch: Partial<VodFilters>) => onChange({ ...filters, ...patch });
  const count = <T,>(list: T[] | undefined, match: (item: T) => boolean, key: (item: T) => number) => {
    const found = list?.find(match);
    return found ? key(found) : facets ? 0 : undefined;
  };
  const toggle = <T,>(values: T[], value: T) => (values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);

  const genres = GENRES.filter((id) => filters.genres.includes(id) || !facets || facets.genres.some((genre) => genre.id === id && genre.count > 0));
  const decades = facets?.decades ?? [];

  return (
    <section aria-label={t('vod.filters.title')} className="card space-y-4 p-4">
      <TitleFilter value={filters.q} onChange={(q) => set({ q })} />

      <Group label={t('vod.filters.genre')}>
        {genres.length === 0 && <p className="text-sm text-fg-subtle">{t('vod.filters.noGenres')}</p>}
        {genres.map((id) => (
          <Choice key={id} active={filters.genres.includes(id)} count={count(facets?.genres, (genre) => genre.id === id, (genre) => genre.count)} onClick={() => set({ genres: toggle(filters.genres, id) })}>
            {t(`vod.genre.${id}`)}
          </Choice>
        ))}
      </Group>

      {(decades.length > 0 || filters.decade !== null) && (
        <Group label={t('vod.filters.decade')}>
          {decades.map((decade) => (
            <Choice key={decade.decade} active={filters.decade === decade.decade} count={decade.count} onClick={() => set({ decade: filters.decade === decade.decade ? null : decade.decade })}>
              {t('vod.filters.decadeValue', { decade: decade.decade })}
            </Choice>
          ))}
          {filters.decade !== null && !decades.some((decade) => decade.decade === filters.decade) && (
            <Choice active count={0} onClick={() => set({ decade: null })}>
              {t('vod.filters.decadeValue', { decade: filters.decade })}
            </Choice>
          )}
        </Group>
      )}

      <Group label={t('vod.filters.rating')}>
        {RATINGS.map((min) => (
          <Choice key={min} active={filters.rating === min} count={count(facets?.ratings, (rating) => rating.min === min, (rating) => rating.count)} onClick={() => set({ rating: filters.rating === min ? null : min })}>
            {t('vod.filters.ratingValue', { min })}
          </Choice>
        ))}
      </Group>

      {kind === 'movies' && (
        <Group label={t('vod.filters.length')}>
          {LENGTHS.map((id) => (
            <Choice key={id} active={filters.length === id} count={count(facets?.lengths, (length) => length.id === id, (length) => length.count)} onClick={() => set({ length: filters.length === id ? null : id })}>
              {t(`vod.filters.lengths.${id}`)}
            </Choice>
          ))}
        </Group>
      )}

      <Group label={t('vod.filters.added')}>
        {ADDED_DAYS.map((days) => (
          <Choice key={days} active={filters.added === days} count={count(facets?.added, (added) => added.days === days, (added) => added.count)} onClick={() => set({ added: filters.added === days ? null : days })}>
            {t(`vod.filters.addedWithin.d${days}`)}
          </Choice>
        ))}
      </Group>

      <Group label={t('vod.filters.watched')}>
        {WATCH.filter((id) => kind === 'movies' || id !== 'finished').map((id) => (
          <Choice key={id} active={filters.watch === id} onClick={() => set({ watch: filters.watch === id ? null : id })}>
            {t(`vod.filters.watch.${kind === 'series' && id === 'started' ? 'startedSeries' : id}`)}
          </Choice>
        ))}
      </Group>

      {sources.length > 1 && (
        <Group label={t('vod.filters.source')}>
          {sources.map((source) => (
            <Choice key={source.id} active={filters.sources.includes(source.id)} count={count(facets?.sources, (item) => item.sourceId === source.id, (item) => item.count)} onClick={() => set({ sources: toggle(filters.sources, source.id) })}>
              {source.name}
            </Choice>
          ))}
        </Group>
      )}
    </section>
  );
}

/** The active filters as removable chips, plus "Clear all". */
export function ActiveFilters({ kind, filters, onChange, sources }: { kind: VodKind; filters: VodFilters; onChange: (filters: VodFilters) => void; sources: SourceDto[] }) {
  const chips: { key: string; label: string; remove: () => VodFilters }[] = [
    ...(filters.q.trim() ? [{ key: 'q', label: `“${filters.q.trim()}”`, remove: () => ({ ...filters, q: '' }) }] : []),
    ...filters.genres.map((id) => ({ key: `g-${id}`, label: t(`vod.genre.${id}`), remove: () => ({ ...filters, genres: filters.genres.filter((item) => item !== id) }) })),
    ...(filters.decade !== null ? [{ key: 'decade', label: t('vod.filters.decadeValue', { decade: filters.decade }), remove: () => ({ ...filters, decade: null }) }] : []),
    ...(filters.rating !== null ? [{ key: 'rating', label: t('vod.filters.ratingValue', { min: filters.rating }), remove: () => ({ ...filters, rating: null }) }] : []),
    ...(filters.length ? [{ key: 'length', label: t(`vod.filters.lengths.${filters.length}`), remove: () => ({ ...filters, length: null }) }] : []),
    ...(filters.added !== null ? [{ key: 'added', label: t(`vod.filters.addedWithin.d${filters.added as 7 | 30 | 90 | 365}`), remove: () => ({ ...filters, added: null }) }] : []),
    ...(filters.watch ? [{ key: 'watch', label: t(`vod.filters.watch.${kind === 'series' && filters.watch === 'started' ? 'startedSeries' : filters.watch}`), remove: () => ({ ...filters, watch: null }) }] : []),
    ...filters.sources.map((id) => ({ key: `s-${id}`, label: sources.find((source) => source.id === id)?.name ?? t('vod.source'), remove: () => ({ ...filters, sources: filters.sources.filter((item) => item !== id) }) })),
  ];
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <span key={chip.key} className="inline-flex items-center gap-1 rounded-full bg-brand/15 py-1 pl-3 pr-1 text-sm text-fg">
          {chip.label}
          <button type="button" onClick={() => onChange(chip.remove())} aria-label={t('vod.filters.remove', { name: chip.label })} className="rounded-full p-0.5 text-fg-muted hover:bg-fg/10 hover:text-fg">
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      ))}
      <button type="button" onClick={() => onChange({ genres: [], decade: null, rating: null, length: null, added: null, watch: null, sources: [], q: '' })} className="text-sm font-medium text-brand-soft hover:underline">
        {t('vod.filters.clear')}
      </button>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id}>
      <p id={id} className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
        {label}
      </p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function Choice({ active, count, onClick, children }: { active: boolean; count?: number | undefined; onClick: () => void; children: ReactNode }) {
  const empty = count === 0 && !active;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm ring-1 ring-inset transition-colors',
        active ? 'bg-brand text-white ring-brand' : 'text-fg-muted ring-line/10 hover:bg-fg/5 hover:text-fg',
        empty && 'opacity-50',
      )}
    >
      {children}
      {count !== undefined && <span className={cn('text-xs tabular-nums', active ? 'text-white/80' : 'text-fg-subtle')}>{count.toLocaleString()}</span>}
    </button>
  );
}

/** Narrow by title; waits for a pause in typing before filtering. */
function TitleFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  const id = useId();
  // The value changed from outside (a chip removed, "Clear all"): show it.
  if (value !== synced) {
    setSynced(value);
    setDraft(value);
  }
  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => onChange(draft), 300);
    return () => window.clearTimeout(timer);
  }, [draft, value, onChange]);
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        {t('vod.filters.titleLabel')}
      </label>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
      <input id={id} type="search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t('vod.filters.titlePlaceholder')} className="field h-10 w-full pl-9" maxLength={100} />
    </div>
  );
}

import { Clapperboard, MonitorPlay, Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Link } from 'react-router';

import { EmptyState } from '../../components/ui/EmptyState';
import { Img, Initials } from '../../components/ui/Img';
import { Segmented } from '../../components/ui/Segmented';
import { Spinner } from '../../components/ui/Spinner';
import { useOperatorVod } from '../../features/operator/api';
import { errorMessage } from '../../lib/api-client';
import { imageSources } from '../../lib/images';
import { paths } from '../../lib/routes';
import { t } from '../../i18n';
import { AccessBadge } from './AccessBadge';

/**
 * /films — the operator's licensed films and series. Each title says whether the viewer's plan
 * includes it ("In your plan") or which plan would ("Upgrade"); the server decides, the page shows.
 */
export function FilmsPage() {
  const [type, setType] = useState<'movie' | 'series'>('movie');
  const [text, setText] = useState('');
  const q = useDeferredValue(text.trim());
  const vod = useOperatorVod(type, q);
  return (
    <div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-fg">{t('films.title')}</h1>
        <p className="text-sm text-fg-muted">{t('films.intro')}</p>
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label={t('films.kind')}
          value={type}
          onChange={setType}
          className="w-full sm:w-80"
          options={[
            { value: 'movie', label: t('films.movies'), icon: <Clapperboard className="h-4 w-4" /> },
            { value: 'series', label: t('films.series'), icon: <MonitorPlay className="h-4 w-4" /> },
          ]}
        />
        <label className="relative min-w-0 flex-1 sm:max-w-xs">
          <span className="sr-only">{t('films.search')}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <input type="search" value={text} onChange={(event) => setText(event.target.value)} placeholder={t('films.search')} className="field pl-9" />
        </label>
      </div>
      {vod.isPending ? (
        <Spinner label={t('films.loading')} />
      ) : vod.isError ? (
        <EmptyState tone="error" title={t('films.loadFailed')} description={errorMessage(vod.error)} onRetry={() => void vod.refetch()} />
      ) : vod.data.items.length === 0 ? (
        <EmptyState icon={<Clapperboard className="h-8 w-8" />} title={q ? t('films.noMatch') : t('films.none')} />
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6" aria-label={type === 'movie' ? t('films.movies') : t('films.series')}>
          {vod.data.items.map((item) => (
            <li key={item.id}>
              <Link to={paths.film(item.id)} className="group block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand" title={item.title}>
                <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-fg/5 ring-1 ring-inset ring-line/5">
                  <Img sources={imageSources(item.poster)} className="h-full w-full transition-transform duration-300 group-hover:scale-[1.03]" fallback={<Initials name={item.title} className="text-2xl" />} />
                  <span className="absolute left-1.5 top-1.5 rounded-md bg-black/75 backdrop-blur-sm">
                    <AccessBadge access={item.access} />
                  </span>
                </div>
                <p className="mt-1.5 truncate text-sm font-medium text-fg group-hover:text-brand-soft">{item.title}</p>
                <p className="truncate text-xs text-fg-subtle">{[item.year, item.genres.slice(0, 2).join(', ')].filter(Boolean).join(' · ')}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

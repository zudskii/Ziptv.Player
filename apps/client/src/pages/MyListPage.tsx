import type { ListItemType } from '@ziptv/contracts';
import { Bookmark, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { PosterCard } from '../components/media/PosterCard';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/EmptyState';
import { Segmented } from '../components/ui/Segmented';
import { Spinner } from '../components/ui/Spinner';
import { useMyList, useToggleListItem } from '../features/user-state/api';
import { errorMessage } from '../lib/api-client';
import { itemPath } from '../lib/routes';
import { t } from '../i18n';

type Filter = 'all' | ListItemType;

/** /my-list — channels, movies and series saved by this profile. */
export function MyListPage() {
  const list = useMyList();
  const toggle = useToggleListItem();
  const [filter, setFilter] = useState<Filter>('all');
  const items = (list.data?.items ?? []).filter((item) => filter === 'all' || item.type === filter);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-fg">{t('myList.title')}</h1>
        <Segmented<Filter>
          label={t('myList.show')}
          size="sm"
          className="ml-auto w-full max-w-sm sm:w-auto"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('myList.all') },
            { value: 'channel', label: t('myList.channels') },
            { value: 'movie', label: t('myList.movies') },
            { value: 'series', label: t('myList.series') },
          ]}
        />
      </header>
      {list.isPending ? (
        <Spinner label={t('myList.loading')} />
      ) : list.isError ? (
        <EmptyState title={t('myList.loadFailed')} description={errorMessage(list.error)} />
      ) : items.length === 0 ? (
        <EmptyState icon={<Bookmark className="h-8 w-8" />} title={t('myList.empty')} description={t('myList.emptyHint')} />
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-3 gap-y-5 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
          {items.map((item) => (
            <li key={`${item.sourceId}:${item.type}:${item.key}`} className="relative">
              <PosterCard
                layout="grid"
                to={itemPath(item)}
                sourceId={item.sourceId}
                type={item.type}
                itemKey={item.key}
                title={item.title}
                image={item.image}
                subtitle={item.subtitle}
                badge={!item.available ? <Badge tone="warning">{t('myList.unavailable')}</Badge> : undefined}
              />
              <button
                type="button"
                aria-label={t('myList.removeNamed', { title: item.title })}
                onClick={() => toggle.mutate({ item, add: false }, { onError: (error) => toast.error(errorMessage(error)) })}
                className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

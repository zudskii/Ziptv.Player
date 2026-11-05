import type { HistoryItemDto } from '@ziptv/contracts';
import { History, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { Button, IconButton } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { Img, Initials } from '../components/ui/Img';
import { Spinner } from '../components/ui/Spinner';
import { useClearData, useHistory, useRemoveHistory } from '../features/user-state/api';
import { errorMessage } from '../lib/api-client';
import { historyImageSources } from '../lib/images';
import { historyPath } from '../lib/routes';
import { formatClock, formatDay, formatDuration } from '../lib/time';
import { LoadMore } from './vod/VodBrowsePage';
import { t } from '../i18n';

const KIND_KEYS = { channel: 'kind.live', operator: 'kind.channel', catchup: 'kind.catchup', movie: 'kind.movie', episode: 'kind.episode' } as const;

/** /history — every viewing of this profile, newest first, grouped by day. */
export function HistoryPage() {
  const history = useHistory();
  const remove = useRemoveHistory();
  const clear = useClearData();
  const [confirm, setConfirm] = useState(false);
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  const days = new Map<string, HistoryItemDto[]>();
  for (const item of items) {
    const day = formatDay(item.watchedAt);
    days.set(day, [...(days.get(day) ?? []), item]);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <header className="flex items-center gap-3">
        <h1 className="flex-1 text-2xl font-bold text-fg">{t('history.title')}</h1>
        {items.length > 0 && (
          <Button icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirm(true)}>
            {t('history.clear')}
          </Button>
        )}
      </header>
      {history.isPending ? (
        <Spinner label={t('history.loading')} />
      ) : history.isError ? (
        <EmptyState title={t('history.loadFailed')} description={errorMessage(history.error)} />
      ) : items.length === 0 ? (
        <EmptyState icon={<History className="h-8 w-8" />} title={t('history.empty')} description={t('history.emptyHint')} />
      ) : (
        [...days.entries()].map(([day, entries]) => (
          <section key={day} aria-label={day}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-subtle">{day}</h2>
            <ul className="space-y-2">
              {entries.map((item) => (
                <HistoryRow key={item.id} item={item} onRemove={() => remove.mutate(item.id, { onError: (error) => toast.error(errorMessage(error)) })} />
              ))}
            </ul>
          </section>
        ))
      )}
      {history.hasNextPage && <LoadMore loading={history.isFetchingNextPage} onLoad={() => void history.fetchNextPage()} />}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t('history.clearTitle')}
        description={t('history.clearHint')}
        confirmLabel={t('history.clear')}
        onConfirm={async () => {
          await clear.mutateAsync('history');
          toast.success(t('history.cleared'));
        }}
      />
    </div>
  );
}

function HistoryRow({ item, onRemove }: { item: HistoryItemDto; onRemove: () => void }) {
  const channel = item.contentType === 'channel' || item.contentType === 'catchup' || item.contentType === 'operator';
  const to = historyPath(item);
  return (
    <li className="card flex items-center gap-3 p-2.5">
      <Link to={to} className="flex min-w-0 flex-1 items-center gap-3 hover:text-brand-soft">
        <Img
          sources={historyImageSources(item)}
          fit={channel ? 'contain' : 'cover'}
          className="h-12 w-20 shrink-0 rounded-md bg-fg/5"
          fallback={<Initials name={item.title} />}
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-fg">{item.title}</span>
          <span className="block truncate text-xs text-fg-subtle">
            {[t(KIND_KEYS[item.contentType]), item.subtitle, formatClock(item.watchedAt), formatDuration(item.watchedSecs) ? t('history.watched', { duration: formatDuration(item.watchedSecs) }) : null].filter(Boolean).join(' · ')}
          </span>
        </span>
      </Link>
      <IconButton label={t('history.remove', { title: item.title })} onClick={onRemove}>
        <X className="h-4 w-4" />
      </IconButton>
    </li>
  );
}

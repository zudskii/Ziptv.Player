import type { SourceDto } from '@ziptv/contracts';
import { Plus, Server } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { EmptyState } from '../components/ui/EmptyState';
import { FullscreenMessage } from '../components/ui/FullscreenMessage';
import { Spinner } from '../components/ui/Spinner';
import { errorMessage } from '../lib/api-client';
import { GuideManager } from '../features/epg/components/GuideManager';
import { useSources } from '../features/sources/api';
import { AddSourceForm } from '../features/sources/components/AddSourceForm';
import { SourceCard } from '../features/sources/components/SourceCard';
import { SourceSettingsDialog } from '../features/sources/components/SourceSettingsDialog';
import { t } from '../i18n';

/** Settings → Sources: every provider the user added, its sync state, health and actions. */
export function SourcesPage({ children }: { children?: ReactNode }) {
  const sourcesQuery = useSources();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SourceDto | null>(null);
  const sources = sourcesQuery.data ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-fg">{t('sources.title')}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t('sources.intro')}</p>
        </div>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
          {t('sources.form.add')}
        </Button>
      </header>

      {sourcesQuery.isPending ? (
        <Spinner className="py-16" label={t('sources.loading')} />
      ) : sourcesQuery.isError ? (
        <FullscreenMessage tone="error" title={t('sources.loadFailed')} description={errorMessage(sourcesQuery.error)} action={{ label: t('sources.retry'), onClick: () => void sourcesQuery.refetch() }} />
      ) : sources.length === 0 ? (
        <EmptyState
          icon={<Server className="h-8 w-8" />}
          title={t('sources.none')}
          description={t('sources.noneHint')}
          action={
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
              {t('sources.addFirst')}
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {sources.map((source) => (
            <SourceCard key={source.id} source={source} onEdit={setEditing} />
          ))}
        </div>
      )}

      {sources.length > 0 && <GuideManager sources={sources} />}

      {children}

      <Dialog open={adding} onClose={() => setAdding(false)} title={t('sources.form.add')} description={t('sources.addHint')}>
        <AddSourceForm
          onCancel={() => setAdding(false)}
          onAdded={(source) => {
            setAdding(false);
            toast.success(`“${source.name}” added`, { description: source.type === 'm3u_file' ? `${source.stats.live.toLocaleString()} channels` : t('sources.syncingBg') });
          }}
        />
      </Dialog>
      <SourceSettingsDialog source={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

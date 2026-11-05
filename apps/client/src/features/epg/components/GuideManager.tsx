import type { GuideSourceDto, SourceDto } from '@ziptv/contracts';
import { CalendarDays, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Badge } from '../../../components/ui/Badge';
import { Button, IconButton } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { errorMessage } from '../../../lib/api-client';
import { formatAgo, formatIn } from '../../../lib/time';
import { useNow } from '../../../lib/use-now';
import { useAddGuide, useGuides, useRemoveGuide, useSyncGuide, useUpdateGuide } from '../api';
import { i18n, t } from '../../../i18n';


/** Settings → Sources → TV guides (EPG sources): announced guides and manually added XMLTV URLs. */
export function GuideManager({ sources }: { sources: SourceDto[] }) {
  const guides = useGuides();
  const [adding, setAdding] = useState(false);
  const list = guides.data ?? [];

  return (
    <section className="space-y-3" aria-labelledby="guides-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="guides-heading" className="text-lg font-semibold text-fg">
            {t('epg.manager.title')}
          </h2>
          <p className="text-sm text-fg-muted">{t('epg.manager.intro')}</p>
        </div>
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)} disabled={sources.length === 0}>
          {t('epg.manager.add')}
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line/10 p-6 text-center text-sm text-fg-muted">
          {t('epg.manager.none')}
        </p>
      ) : (
        <ul className="space-y-2">
          {list.map((guide) => (
            <GuideRow key={guide.id} guide={guide} sources={sources} />
          ))}
        </ul>
      )}
      <AddGuideDialog open={adding} sources={sources} onClose={() => setAdding(false)} />
    </section>
  );
}

function GuideRow({ guide, sources }: { guide: GuideSourceDto; sources: SourceDto[] }) {
  const now = useNow(30_000);
  const sync = useSyncGuide();
  const remove = useRemoveGuide();
  const update = useUpdateGuide();
  const [editing, setEditing] = useState(false);
  const syncing = guide.sync.status === 'queued' || guide.sync.status === 'running';
  const names = guide.sourceIds.map((id) => sources.find((source) => source.id === id)?.name).filter(Boolean);

  return (
    <li className="card p-3">
      <div className="flex items-start gap-3">
        <CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-brand-soft" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-medium text-fg">{guide.name}</p>
            <Badge>{t(`epg.origin.${guide.origin}`)}</Badge>
            {guide.sync.status === 'failed' && <Badge tone="warning">{t('epg.manager.unavailable')}</Badge>}
          </div>
          <p className="truncate text-xs text-fg-subtle">
            {guide.host} · {names.length > 0 ? t('epg.usedBy', { names: i18n.formatList(names.filter((name): name is string => Boolean(name))) }) : t('epg.notUsed')}
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            {syncing
              ? t('epg.manager.updating')
              : guide.sync.lastSuccessAt
                ? t('epg.stats', { programmes: guide.stats.programmes, kept: guide.stats.keptChannels, channels: guide.stats.channels, when: formatAgo(guide.sync.lastSuccessAt, now) })
                : t('epg.manager.notLoaded')}
            {!syncing && guide.sync.nextSyncAt && t('epg.next', { when: formatIn(guide.sync.nextSyncAt, now) })}
          </p>
          {guide.sync.error && (
            <p className="mt-1 flex items-center gap-1 text-xs text-amber-500">
              <TriangleAlert className="h-3.5 w-3.5" /> {guide.sync.error}
            </p>
          )}
          {editing && guide.origin === 'manual' && (
            <SourcePicker
              sources={sources}
              value={guide.sourceIds}
              onChange={async (sourceIds) => {
                try {
                  await update.mutateAsync({ id: guide.id, patch: { sourceIds } });
                } catch (error) {
                  toast.error(errorMessage(error));
                }
              }}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center">
          {guide.origin === 'manual' && (
            <Button size="sm" variant="ghost" onClick={() => setEditing((value) => !value)}>
              {editing ? t('epg.done') : t('epg.manager.sources')}
            </Button>
          )}
          <IconButton label={t('epg.manager.update')} onClick={() => sync.mutate(guide.id)} disabled={syncing}>
            <RefreshCw className={syncing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </IconButton>
          {guide.origin === 'manual' && (
            <IconButton
              label={t('epg.manager.remove')}
              onClick={() => {
                if (window.confirm(t('epg.removeGuideConfirm', { name: guide.name }))) remove.mutate(guide.id);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      </div>
    </li>
  );
}

function SourcePicker({ sources, value, onChange }: { sources: SourceDto[]; value: string[]; onChange: (sourceIds: string[]) => void }) {
  return (
    <fieldset className="mt-2 flex flex-wrap gap-2">
      <legend className="sr-only">{t('epg.manager.usingSources')}</legend>
      {sources.map((source) => {
        const checked = value.includes(source.id);
        return (
          <label key={source.id} className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-fg/5 px-2.5 py-1.5 text-xs text-fg">
            <input type="checkbox" checked={checked} onChange={() => onChange(checked ? value.filter((id) => id !== source.id) : [...value, source.id])} className="accent-brand" />
            {source.name}
          </label>
        );
      })}
    </fieldset>
  );
}

function AddGuideDialog({ open, sources, onClose }: { open: boolean; sources: SourceDto[]; onClose: () => void }) {
  const add = useAddGuide();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const ids = { url: useId(), name: useId() };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const guide = await add.mutateAsync({ url: url.trim(), name: name.trim() || undefined, sourceIds: sourceIds.length ? sourceIds : undefined });
      toast.success(t('epg.added', { name: guide.name }), { description: t('epg.loadingProgrammes') });
      setUrl('');
      setName('');
      setSourceIds([]);
      onClose();
    } catch (error) {
      toast.error(t('epg.manager.addFailed'), { description: errorMessage(error) });
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('epg.manager.add')} description={t('epg.manager.addHint')}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor={ids.url} className="text-sm text-fg-muted">
            {t('epg.manager.url')}
          </label>
          <input id={ids.url} type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://epg.example/guide.xml.gz" className="field" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={ids.name} className="text-sm text-fg-muted">
            {t('epg.manager.name')} <span className="text-fg-subtle">{t('epg.manager.optional')}</span>
          </label>
          <input id={ids.name} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} className="field" />
        </div>
        <div>
          <p className="text-sm text-fg-muted">{sourceIds.length === 0 ? t('epg.useForAll') : t('epg.useForThese')}</p>
          <SourcePicker sources={sources} value={sourceIds} onChange={setSourceIds} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('epg.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!/^https?:\/\/\S+$/i.test(url.trim())}>
            {t('epg.manager.addGuide')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

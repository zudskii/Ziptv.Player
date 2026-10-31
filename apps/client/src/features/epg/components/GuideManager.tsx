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

const ORIGIN_LABELS = { playlist: 'From playlist', xtream: 'From provider', manual: 'Added by you' } as const;

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
            TV guides
          </h2>
          <p className="text-sm text-fg-muted">XMLTV programme guides. ZIPTV refreshes them every 3 hours and matches them to your channels.</p>
        </div>
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)} disabled={sources.length === 0}>
          Add XMLTV guide
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line/10 p-6 text-center text-sm text-fg-muted">
          No guides yet. Playlists that announce a guide (url-tvg) add it automatically.
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
            <Badge>{ORIGIN_LABELS[guide.origin]}</Badge>
            {guide.sync.status === 'failed' && <Badge tone="warning">Unavailable</Badge>}
          </div>
          <p className="truncate text-xs text-fg-subtle">
            {guide.host} · {names.length > 0 ? `used by ${names.join(', ')}` : 'not used by any source'}
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            {syncing
              ? 'Updating…'
              : guide.sync.lastSuccessAt
                ? `${guide.stats.programmes.toLocaleString()} programmes for ${guide.stats.keptChannels.toLocaleString()} of ${guide.stats.channels.toLocaleString()} guide channels · updated ${formatAgo(guide.sync.lastSuccessAt, now)}`
                : 'Not loaded yet'}
            {!syncing && guide.sync.nextSyncAt && ` · next ${formatIn(guide.sync.nextSyncAt, now)}`}
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
              {editing ? 'Done' : 'Sources'}
            </Button>
          )}
          <IconButton label="Update now" onClick={() => sync.mutate(guide.id)} disabled={syncing}>
            <RefreshCw className={syncing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </IconButton>
          {guide.origin === 'manual' && (
            <IconButton
              label="Remove guide"
              onClick={() => {
                if (window.confirm(`Remove the guide “${guide.name}”?`)) remove.mutate(guide.id);
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
      <legend className="sr-only">Sources using this guide</legend>
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
      toast.success(`“${guide.name}” added`, { description: 'Loading programmes…' });
      setUrl('');
      setName('');
      setSourceIds([]);
      onClose();
    } catch (error) {
      toast.error('Could not add the guide', { description: errorMessage(error) });
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add XMLTV guide" description="A programme guide URL (.xml or .xml.gz).">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor={ids.url} className="text-sm text-fg-muted">
            Guide URL
          </label>
          <input id={ids.url} type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://epg.example/guide.xml.gz" className="field" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={ids.name} className="text-sm text-fg-muted">
            Name <span className="text-fg-subtle">(optional)</span>
          </label>
          <input id={ids.name} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} className="field" />
        </div>
        <div>
          <p className="text-sm text-fg-muted">Use for {sourceIds.length === 0 ? 'all sources' : 'these sources'}:</p>
          <SourcePicker sources={sources} value={sourceIds} onChange={setSourceIds} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!/^https?:\/\/\S+$/i.test(url.trim())}>
            Add guide
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

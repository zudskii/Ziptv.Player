import type { SourceDto } from '@ziptv/contracts';
import { FileUp } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Switch } from '../../../components/ui/Switch';
import { errorMessage } from '../../../lib/api-client';
import { useReplaceSourceFile, useUpdateSource } from '../api';
import { SOURCE_TYPE_LABELS, SYNC_INTERVALS } from '../source-status';

interface SourceSettingsDialogProps {
  source: SourceDto | null;
  onClose: () => void;
}

/** Rename, sync schedule, playlist link / Xtream credentials, replace an uploaded file. */
export function SourceSettingsDialog({ source, onClose }: SourceSettingsDialogProps) {
  return (
    <Dialog open={source !== null} onClose={onClose} title="Source settings" description={source ? `${source.name} · ${SOURCE_TYPE_LABELS[source.type]}` : undefined}>
      {source && <SettingsForm key={source.id} source={source} onDone={onClose} />}
    </Dialog>
  );
}

function SettingsForm({ source, onDone }: { source: SourceDto; onDone: () => void }) {
  const update = useUpdateSource();
  const replace = useReplaceSourceFile();
  const [name, setName] = useState(source.name);
  const [autoSync, setAutoSync] = useState(source.sync.autoSync);
  const [intervalHours, setIntervalHours] = useState(source.sync.intervalHours);
  const [url, setUrl] = useState('');
  const [xtream, setXtream] = useState({ server: source.origin.kind === 'xtream' ? `http://${source.origin.host}` : '', username: '', password: '' });
  const [file, setFile] = useState<File | null>(null);
  const ids = { name: useId(), url: useId(), interval: useId() };
  const remote = source.type !== 'm3u_file';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (source.type === 'm3u_file' && file) await replace.mutateAsync({ id: source.id, file });
      const patch = {
        ...(name.trim() && name.trim() !== source.name ? { name: name.trim() } : {}),
        ...(remote && autoSync !== source.sync.autoSync ? { autoSync } : {}),
        ...(remote && intervalHours !== source.sync.intervalHours ? { intervalHours } : {}),
        ...(source.type === 'm3u_url' && url.trim() ? { url: url.trim() } : {}),
        ...(source.type === 'xtream' && xtream.username && xtream.password ? { xtream: { ...xtream, server: xtream.server.trim() } } : {}),
      };
      if (Object.keys(patch).length > 0) await update.mutateAsync({ id: source.id, patch });
      toast.success('Source updated', { description: patch.url || patch.xtream ? 'Checking the new connection…' : undefined });
      onDone();
    } catch (error) {
      toast.error('Could not update the source', { description: errorMessage(error) });
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor={ids.name} className="text-sm text-fg-muted">
          Name
        </label>
        <input id={ids.name} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className="field" />
      </div>

      {remote && (
        <div className="rounded-lg bg-sunken/40 px-3 py-1">
          <Switch checked={autoSync} onChange={setAutoSync} label="Sync automatically" description="Re-reads channels, movies and series in the background." />
          {autoSync && (
            <div className="flex items-center justify-between gap-3 pb-2">
              <label htmlFor={ids.interval} className="text-sm text-fg-muted">
                How often
              </label>
              <select id={ids.interval} value={intervalHours} onChange={(event) => setIntervalHours(Number(event.target.value))} className="field h-9 w-44">
                {SYNC_INTERVALS.map((option) => (
                  <option key={option.hours} value={option.hours}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {source.type === 'm3u_url' && (
        <div className="space-y-1.5">
          <label htmlFor={ids.url} className="text-sm text-fg-muted">
            New playlist link <span className="text-fg-subtle">(leave empty to keep the current one)</span>
          </label>
          <input id={ids.url} type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder={`Current: ${source.origin.kind === 'url' ? source.origin.host : ''}/…`} className="field" />
        </div>
      )}

      {source.type === 'xtream' && (
        <fieldset className="space-y-2">
          <legend className="text-sm text-fg-muted">
            Xtream credentials <span className="text-fg-subtle">(fill in to replace)</span>
          </legend>
          <input aria-label="Server URL" type="url" value={xtream.server} onChange={(event) => setXtream({ ...xtream, server: event.target.value })} className="field" />
          <div className="grid gap-2 sm:grid-cols-2">
            <input aria-label="Username" placeholder="Username" autoComplete="off" value={xtream.username} onChange={(event) => setXtream({ ...xtream, username: event.target.value })} className="field" />
            <input aria-label="Password" placeholder="Password" type="password" autoComplete="off" value={xtream.password} onChange={(event) => setXtream({ ...xtream, password: event.target.value })} className="field" />
          </div>
        </fieldset>
      )}

      {source.type === 'm3u_file' && (
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-line/15 px-3 py-3 text-sm hover:bg-fg/5">
          <FileUp className="h-5 w-5 text-fg-subtle" />
          <span className="min-w-0 flex-1 truncate text-fg-muted">{file ? file.name : 'Replace with a new playlist file (channel keys stay the same)'}</span>
          <input type="file" className="sr-only" accept=".m3u,.m3u8,.pls,.txt" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={update.isPending || replace.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

import type { PlaylistEntryDto } from '@ziptv/contracts';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { errorMessage } from '../../../lib/api-client';
import { useUpdateEntry } from '../api';
import { buildEntryPatch, formFromEntry, type EntryFormErrors, type EntryFormValues } from '../entry-form';
import { t } from '../../../i18n';

interface EditEntryDialogProps {
  entry: PlaylistEntryDto | null;
  playlistId: string;
  onClose: () => void;
}

/** Rename a channel, give it a number, fix its guide id or logo. Only this playlist changes, never the source. */
export function EditEntryDialog({ entry, playlistId, onClose }: EditEntryDialogProps) {
  return (
    <Dialog open={entry !== null} onClose={onClose} title={t('playlists.edit.title')} description={t('playlists.edit.hint')}>
      {entry && <EditForm key={entry.id} entry={entry} playlistId={playlistId} onClose={onClose} />}
    </Dialog>
  );
}

function EditForm({ entry, playlistId, onClose }: { entry: PlaylistEntryDto; playlistId: string; onClose: () => void }) {
  const update = useUpdateEntry(playlistId);
  const ids = { name: useId(), number: useId(), tvgId: useId(), logo: useId() };
  const [form, setForm] = useState<EntryFormValues>(formFromEntry(entry));
  const [errors, setErrors] = useState<EntryFormErrors>({});
  const set = (key: keyof EntryFormValues) => (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: event.target.value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const { patch, errors: found } = buildEntryPatch(entry, form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (!patch) return onClose();
    try {
      await update.mutateAsync({ entryId: entry.id, patch });
      onClose();
    } catch (reason) {
      toast.error(errorMessage(reason));
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field id={ids.name} label={t('playlists.name')} error={errors.name}>
        <input id={ids.name} autoFocus value={form.name} maxLength={300} onChange={set('name')} className="field" />
      </Field>
      <Field id={ids.number} label={t('playlists.edit.number')} error={errors.number} hint={t('playlists.edit.numberHint')}>
        <input id={ids.number} inputMode="numeric" value={form.number} onChange={set('number')} className="field" />
      </Field>
      <Field id={ids.tvgId} label={t('playlists.edit.guideId')} error={errors.tvgId} hint={t('playlists.edit.guideIdHint')}>
        <input id={ids.tvgId} value={form.tvgId} onChange={set('tvgId')} spellCheck={false} className="field" />
      </Field>
      <Field id={ids.logo} label={t('playlists.edit.logo')} error={errors.logo}>
        <input id={ids.logo} type="url" inputMode="url" value={form.logo} onChange={set('logo')} spellCheck={false} placeholder="https://…" className="field" />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
          {t('playlists.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={update.isPending}>
          {t('playlists.save')}
        </Button>
      </div>
    </form>
  );
}

function Field({ id, label, error, hint, children }: { id: string; label: string; error: string | undefined; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm text-fg-muted">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-fg-subtle">{hint}</p>
      )}
    </div>
  );
}

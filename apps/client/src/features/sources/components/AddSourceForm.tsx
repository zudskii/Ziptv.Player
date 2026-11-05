import type { ParseWarningDto, SourceDto } from '@ziptv/contracts';
import { FileUp, KeyRound, Link2, Sparkles } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { Button } from '../../../components/ui/Button';
import { Segmented } from '../../../components/ui/Segmented';
import { ApiError, errorMessage } from '../../../lib/api-client';
import { cn } from '../../../lib/cn';
import { useAddSource, useUploadSource } from '../api';
import { detectXtream } from '../xtream-detect';
import { i18n, t } from '../../../i18n';
import { useActiveProfile, useProfiles } from '../../profiles/api';

type Mode = 'url' | 'file' | 'xtream';

const ACCEPT = '.m3u,.m3u8,.pls,.txt,audio/x-mpegurl,application/vnd.apple.mpegurl,application/x-mpegurl,text/plain';

interface AddSourceFormProps {
  onAdded: (source: SourceDto) => void;
  onCancel?: () => void;
  submitLabel?: string;
  initialMode?: Mode;
}

/** M3U URL / M3U file / Xtream API — used by onboarding and Settings → Sources. */
export function AddSourceForm({ onAdded, onCancel, submitLabel, initialMode = 'url' }: AddSourceFormProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [xtream, setXtream] = useState({ server: '', username: '', password: '' });
  const profiles = useProfiles().data ?? [];
  const active = useActiveProfile();
  // Other grown-up profiles that could see it too (kids profiles are always assigned by hand).
  const others = profiles.filter((profile) => profile.kind === 'standard' && profile.id !== active?.id);
  const [forEveryone, setForEveryone] = useState(false);
  const audience = forEveryone && others.length > 0 ? ('all' as const) : undefined;
  const add = useAddSource();
  const upload = useUploadSource();
  const pending = add.isPending || upload.isPending;
  const error = mode === 'file' ? upload.error : add.error;
  const ids = { name: useId(), url: useId(), server: useId(), username: useId(), password: useId(), audience: useId() };

  const detected = mode === 'url' ? detectXtream(url) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const label = name.trim() || undefined;
    try {
      const source =
        mode === 'file'
          ? await upload.mutateAsync({ file: file!, name: label, ...(audience ? { audience } : {}) })
          : mode === 'url'
            ? await add.mutateAsync({ type: 'm3u_url', url: url.trim(), name: label, ...(audience ? { audience } : {}) })
            : await add.mutateAsync({ type: 'xtream', server: xtream.server.trim(), username: xtream.username.trim(), password: xtream.password, name: label, ...(audience ? { audience } : {}) });
      onAdded(source);
    } catch {
      /* shown inline via the mutation error */
    }
  };

  const canSubmit =
    mode === 'file'
      ? Boolean(file)
      : mode === 'url'
        ? /^https?:\/\/\S+$/i.test(url.trim())
        : /^https?:\/\/\S+$/i.test(xtream.server.trim()) && xtream.username.trim().length > 0 && xtream.password.length > 0;

  return (
    <form onSubmit={submit} className="space-y-4">
      <Segmented
        label={t('sources.form.type')}
        value={mode}
        onChange={(value) => {
          setMode(value);
          add.reset();
          upload.reset();
        }}
        options={[
          { value: 'url', label: t('sources.type.m3u_url'), icon: <Link2 className="h-4 w-4" /> },
          { value: 'file', label: t('sources.type.m3u_file'), icon: <FileUp className="h-4 w-4" /> },
          { value: 'xtream', label: t('sources.form.xtream'), icon: <KeyRound className="h-4 w-4" /> },
        ]}
      />

      {mode === 'url' && (
        <div className="space-y-1.5">
          <label htmlFor={ids.url} className="text-sm text-fg-muted">
            {t('sources.form.url')}
          </label>
          <input
            id={ids.url}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://provider.example/get.php?username=…&type=m3u_plus"
            className="field"
          />
          <p className="text-xs text-fg-subtle">{t('sources.form.urlHint')}</p>
          {detected && (
            <div className="mt-2 flex items-start gap-3 rounded-lg border border-brand/30 bg-brand/5 p-3 text-sm">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-soft" />
              <div className="min-w-0 flex-1">
                <p className="text-fg">{t('sources.form.isXtream')}</p>
                <p className="text-xs text-fg-muted">{t('sources.form.isXtreamHint')}</p>
              </div>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setXtream(detected);
                  setMode('xtream');
                  add.reset();
                }}
              >
                {t('sources.form.useXtream')}
              </Button>
            </div>
          )}
        </div>
      )}

      {mode === 'file' && (
        <label
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const dropped = event.dataTransfer.files[0];
            if (dropped) setFile(dropped);
          }}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors',
            dragging ? 'border-brand bg-brand/10' : 'border-line/10 hover:border-line/20 hover:bg-fg/5',
          )}
        >
          <FileUp className="h-8 w-8 text-fg-subtle" aria-hidden />
          <span className="text-sm text-fg">{file ? file.name : t('sources.form.drop')}</span>
          <span className="text-xs text-fg-subtle">{file ? `${(file.size / 1024).toFixed(0)} KB` : '.m3u · .m3u8 · .pls'}</span>
          {/* Accept by extension, not MIME: browsers report .m3u8 as 4+ different types. */}
          <input type="file" accept={ACCEPT} className="sr-only" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>
      )}

      {mode === 'xtream' && (
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <label htmlFor={ids.server} className="text-sm text-fg-muted">
              {t('sources.form.server')}
            </label>
            <input
              id={ids.server}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={xtream.server}
              onChange={(event) => setXtream({ ...xtream, server: event.target.value })}
              placeholder="http://provider.example:8080"
              className="field"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor={ids.username} className="text-sm text-fg-muted">
                {t('sources.form.username')}
              </label>
              <input id={ids.username} autoComplete="off" spellCheck={false} value={xtream.username} onChange={(event) => setXtream({ ...xtream, username: event.target.value })} className="field" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={ids.password} className="text-sm text-fg-muted">
                {t('sources.form.password')}
              </label>
              <input id={ids.password} type="password" autoComplete="off" value={xtream.password} onChange={(event) => setXtream({ ...xtream, password: event.target.value })} className="field" />
            </div>
          </div>
          <p className="text-xs text-fg-subtle">{t('sources.form.encrypted')}</p>
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor={ids.name} className="text-sm text-fg-muted">
          {t('sources.form.name')} <span className="text-fg-subtle">{t('sources.form.optional')}</span>
        </label>
        <input id={ids.name} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder={t('sources.form.namePlaceholder')} className="field" />
      </div>

      {others.length > 0 && (
        <label htmlFor={ids.audience} className="flex cursor-pointer items-start gap-3 rounded-lg border border-line/10 p-3">
          <input id={ids.audience} type="checkbox" checked={forEveryone} onChange={(event) => setForEveryone(event.target.checked)} className="mt-0.5 h-4 w-4 accent-brand" />
          <span className="min-w-0">
            <span className="block text-sm text-fg">{t('library.addForAll')}</span>
            <span className="block text-xs text-fg-muted">
              {forEveryone ? t('library.addForAllOn', { names: i18n.formatList(others.map((profile) => profile.name)) }) : t('library.addForAllOff', { name: active?.name ?? '' })}
            </span>
          </span>
        </label>
      )}

      {error && <ErrorBox error={error} />}

      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {t('sources.cancel')}
          </Button>
        )}
        <Button type="submit" variant="primary" loading={pending} disabled={!canSubmit}>
          {submitLabel ?? (mode === 'file' ? t('sources.form.upload') : t('sources.form.add'))}
        </Button>
      </div>
    </form>
  );
}

function ErrorBox({ error }: { error: unknown }) {
  const warnings =
    error instanceof ApiError && error.details && typeof error.details === 'object' && 'warnings' in error.details
      ? ((error.details as { warnings: ParseWarningDto[] }).warnings ?? [])
      : [];
  return (
    <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-500">
      <p>{errorMessage(error)}</p>
      {warnings.length > 0 && (
        <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto font-mono text-xs opacity-80">
          {warnings.map((warning) => (
            <li key={`${warning.line}-${warning.code}`}>
              {t('sources.card.line', { line: warning.line })}
              {warning.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

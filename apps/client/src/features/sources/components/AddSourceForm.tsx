import type { ParseWarningDto, SourceDto } from '@ziptv/contracts';
import { FileUp, KeyRound, Link2, Sparkles } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { Button } from '../../../components/ui/Button';
import { Segmented } from '../../../components/ui/Segmented';
import { ApiError, errorMessage } from '../../../lib/api-client';
import { cn } from '../../../lib/cn';
import { useAddSource, useUploadSource } from '../api';
import { detectXtream } from '../xtream-detect';

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
  const add = useAddSource();
  const upload = useUploadSource();
  const pending = add.isPending || upload.isPending;
  const error = mode === 'file' ? upload.error : add.error;
  const ids = { name: useId(), url: useId(), server: useId(), username: useId(), password: useId() };

  const detected = mode === 'url' ? detectXtream(url) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const label = name.trim() || undefined;
    try {
      const source =
        mode === 'file'
          ? await upload.mutateAsync({ file: file!, name: label })
          : mode === 'url'
            ? await add.mutateAsync({ type: 'm3u_url', url: url.trim(), name: label })
            : await add.mutateAsync({ type: 'xtream', server: xtream.server.trim(), username: xtream.username.trim(), password: xtream.password, name: label });
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
        label="Source type"
        value={mode}
        onChange={(value) => {
          setMode(value);
          add.reset();
          upload.reset();
        }}
        options={[
          { value: 'url', label: 'M3U URL', icon: <Link2 className="h-4 w-4" /> },
          { value: 'file', label: 'M3U file', icon: <FileUp className="h-4 w-4" /> },
          { value: 'xtream', label: 'Xtream', icon: <KeyRound className="h-4 w-4" /> },
        ]}
      />

      {mode === 'url' && (
        <div className="space-y-1.5">
          <label htmlFor={ids.url} className="text-sm text-fg-muted">
            Playlist URL
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
          <p className="text-xs text-fg-subtle">ZIPTV re-reads the playlist in the background (every 6 hours by default).</p>
          {detected && (
            <div className="mt-2 flex items-start gap-3 rounded-lg border border-brand/30 bg-brand/5 p-3 text-sm">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-soft" />
              <div className="min-w-0 flex-1">
                <p className="text-fg">This is an Xtream Codes playlist.</p>
                <p className="text-xs text-fg-muted">Add it as Xtream to get Movies and Series with details, catch-up and account info.</p>
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
                Use Xtream
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
          <span className="text-sm text-fg">{file ? file.name : 'Drop your playlist here or click to browse'}</span>
          <span className="text-xs text-fg-subtle">{file ? `${(file.size / 1024).toFixed(0)} KB` : '.m3u · .m3u8 · .pls'}</span>
          {/* Accept by extension, not MIME: browsers report .m3u8 as 4+ different types. */}
          <input type="file" accept={ACCEPT} className="sr-only" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>
      )}

      {mode === 'xtream' && (
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <label htmlFor={ids.server} className="text-sm text-fg-muted">
              Server URL
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
                Username
              </label>
              <input id={ids.username} autoComplete="off" spellCheck={false} value={xtream.username} onChange={(event) => setXtream({ ...xtream, username: event.target.value })} className="field" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={ids.password} className="text-sm text-fg-muted">
                Password
              </label>
              <input id={ids.password} type="password" autoComplete="off" value={xtream.password} onChange={(event) => setXtream({ ...xtream, password: event.target.value })} className="field" />
            </div>
          </div>
          <p className="text-xs text-fg-subtle">Credentials are encrypted on the server and never shown again.</p>
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor={ids.name} className="text-sm text-fg-muted">
          Name <span className="text-fg-subtle">(optional)</span>
        </label>
        <input id={ids.name} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="e.g. Home IPTV" className="field" />
      </div>

      {error && <ErrorBox error={error} />}

      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" loading={pending} disabled={!canSubmit}>
          {submitLabel ?? (mode === 'file' ? 'Upload' : 'Add source')}
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
              line {warning.line}: {warning.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

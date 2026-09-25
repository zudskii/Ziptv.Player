import type { ParseWarningDto, PlaylistDto } from '@ziptv/contracts';
import { FileUp, Link2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { ApiError, errorMessage } from '../../../lib/api-client';
import { cn } from '../../../lib/cn';
import { useImportPlaylist, useUploadPlaylist } from '../api';

type Mode = 'file' | 'url';

const ACCEPT = '.m3u,.m3u8,.pls,.txt,audio/x-mpegurl,application/vnd.apple.mpegurl,application/x-mpegurl,text/plain';

interface AddPlaylistDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: (playlist: PlaylistDto) => void;
}

export function AddPlaylistDialog({ open, onClose, onAdded }: AddPlaylistDialogProps) {
  const [mode, setMode] = useState<Mode>('file');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const upload = useUploadPlaylist();
  const importUrl = useImportPlaylist();
  const pending = upload.isPending || importUrl.isPending;
  const error = mode === 'file' ? upload.error : importUrl.error;
  const nameId = useId();
  const urlId = useId();

  const reset = () => {
    setName('');
    setUrl('');
    setFile(null);
    upload.reset();
    importUrl.reset();
  };

  const close = () => {
    if (pending) return;
    reset();
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const playlist =
        mode === 'file'
          ? await upload.mutateAsync({ file: file!, name: name.trim() || undefined })
          : await importUrl.mutateAsync({ url: url.trim(), name: name.trim() || undefined });
      toast.success(`“${playlist.name}” added`, {
        description: `${playlist.stats.channels.toLocaleString()} channels in ${playlist.stats.groups} groups${
          playlist.warningCount ? ` · ${playlist.warningCount} entries skipped or flagged` : ''
        }`,
      });
      reset();
      onAdded(playlist);
    } catch {
      /* shown inline via mutation error */
    }
  };

  const canSubmit = mode === 'file' ? Boolean(file) : /^https?:\/\/\S+$/i.test(url.trim());

  return (
    <Dialog open={open} onClose={close} title="Add playlist" description="M3U, M3U8 (extended or plain) and PLS are supported.">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-ink-950/60 p-1" role="tablist">
          {(['file', 'url'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                'flex h-9 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors',
                mode === value ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              {value === 'file' ? <FileUp className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
              {value === 'file' ? 'Upload file' : 'From URL'}
            </button>
          ))}
        </div>

        {mode === 'file' ? (
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
              dragging ? 'border-brand bg-brand/10' : 'border-white/10 hover:border-white/20 hover:bg-white/5',
            )}
          >
            <FileUp className="h-8 w-8 text-slate-400" aria-hidden />
            <span className="text-sm text-slate-200">{file ? file.name : 'Drop your playlist here or click to browse'}</span>
            <span className="text-xs text-slate-500">{file ? `${(file.size / 1024).toFixed(0)} KB` : '.m3u · .m3u8 · .pls'}</span>
            {/* Accept by extension, not MIME: browsers report .m3u8 as 4+ different types. */}
            <input type="file" accept={ACCEPT} className="sr-only" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
        ) : (
          <div className="space-y-1.5">
            <label htmlFor={urlId} className="text-sm text-slate-300">
              Playlist URL
            </label>
            <input
              id={urlId}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://provider.example/get.php?username=…&type=m3u_plus"
              className="h-10 w-full rounded-lg bg-ink-950/70 px-3 text-sm text-white placeholder:text-slate-600 ring-1 ring-inset ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand"
            />
            <p className="text-xs text-slate-500">URL playlists can be refreshed later to pick up new channels and tokens.</p>
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor={nameId} className="text-sm text-slate-300">
            Name <span className="text-slate-500">(optional)</span>
          </label>
          <input
            id={nameId}
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Home IPTV"
            className="h-10 w-full rounded-lg bg-ink-950/70 px-3 text-sm text-white placeholder:text-slate-600 ring-1 ring-inset ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </div>

        {error && <ErrorBox error={error} />}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={pending} disabled={!canSubmit}>
            {mode === 'file' ? 'Upload' : 'Import'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ErrorBox({ error }: { error: unknown }) {
  const warnings =
    error instanceof ApiError && error.details && typeof error.details === 'object' && 'warnings' in error.details
      ? ((error.details as { warnings: ParseWarningDto[] }).warnings ?? [])
      : [];
  return (
    <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-200">
      <p>{errorMessage(error)}</p>
      {warnings.length > 0 && (
        <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto font-mono text-xs text-red-200/80">
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

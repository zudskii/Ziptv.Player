import type { PlaylistDto } from '@ziptv/contracts';
import { Check, Copy, Link2, RefreshCw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '../../../components/ui/Button';
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog';
import { Dialog } from '../../../components/ui/Dialog';
import { errorMessage } from '../../../lib/api-client';
import { copyText } from '../../../lib/clipboard';
import { useDisableExport, useEnableExport } from '../api';

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  playlist: PlaylistDto;
}

/** The public M3U link of a playlist: show, copy, replace, turn off. */
export function ExportDialog({ open, onClose, playlist }: ExportDialogProps) {
  const enable = useEnableExport(playlist.id);
  const disable = useDisableExport(playlist.id);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<'replace' | 'off' | null>(null);
  const url = playlist.export.url;

  const generate = () => enable.mutate(undefined, { onError: (reason) => toast.error(errorMessage(reason)) });

  return (
    <Dialog open={open} onClose={onClose} title="Playlist link" description="Open this playlist in any player (VLC, TiviMate, Kodi, a smart TV…) with a link.">
      <div className="space-y-4">
        {!playlist.export.enabled ? (
          <>
            <p className="text-sm text-fg-muted">
              Nobody can open this playlist from outside ZIPTV until you create a link. You can replace or turn it off at any time.
            </p>
            <div className="flex justify-end">
              <Button variant="primary" icon={<Link2 className="h-4 w-4" />} loading={enable.isPending} onClick={generate}>
                Create link
              </Button>
            </div>
          </>
        ) : (
          <>
            {url ? (
              <div className="space-y-2">
                <label htmlFor="playlist-link" className="text-sm text-fg-muted">
                  M3U link
                </label>
                <div className="flex gap-2">
                  <input id="playlist-link" readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="field font-mono text-xs" />
                  <Button
                    variant="primary"
                    icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    onClick={async () => {
                      const ok = await copyText(url);
                      setCopied(ok);
                      if (ok) setTimeout(() => setCopied(false), 2000);
                      else toast.error('Could not copy. Select the link and copy it manually.');
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </div>
            ) : (
              <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-600 dark:text-amber-400">
                The link works, but it can no longer be shown here (the server&apos;s encryption key changed). Create a new link to see it again.
              </p>
            )}

            <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
              <p className="text-fg-muted">
                <span className="font-medium text-fg">Treat this link like a password.</span> Anyone who has it can see the channels in this playlist <em>and the stream addresses of your provider</em>. If it leaks, replace it.
              </p>
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="danger" onClick={() => setConfirming('off')}>
                Turn off link
              </Button>
              <Button icon={<RefreshCw className="h-4 w-4" />} onClick={() => setConfirming('replace')}>
                Create a new link
              </Button>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirming === 'replace'}
        onClose={() => setConfirming(null)}
        title="Replace the link?"
        description="The current link stops working immediately. Players that use it must be updated with the new one."
        confirmLabel="Replace link"
        tone="primary"
        onConfirm={() => enable.mutateAsync()}
      />
      <ConfirmDialog
        open={confirming === 'off'}
        onClose={() => setConfirming(null)}
        title="Turn off the link?"
        description="The link stops working immediately. You can create a new one later."
        confirmLabel="Turn off"
        onConfirm={() => disable.mutateAsync()}
      />
    </Dialog>
  );
}

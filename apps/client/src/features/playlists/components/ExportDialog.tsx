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
import { t, tx } from '../../../i18n';

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
    <Dialog open={open} onClose={onClose} title={t('playlists.export.title')} description={t('playlists.export.hint')}>
      <div className="space-y-4">
        {!playlist.export.enabled ? (
          <>
            <p className="text-sm text-fg-muted">
              {t('playlists.export.none')}
            </p>
            <div className="flex justify-end">
              <Button variant="primary" icon={<Link2 className="h-4 w-4" />} loading={enable.isPending} onClick={generate}>
                {t('playlists.export.create')}
              </Button>
            </div>
          </>
        ) : (
          <>
            {url ? (
              <div className="space-y-2">
                <label htmlFor="playlist-link" className="text-sm text-fg-muted">
                  {t('playlists.export.m3u')}
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
                      else toast.error(t('playlists.export.copyFailed'));
                    }}
                  >
                    {copied ? t('playlists.copied') : t('playlists.copy')}
                  </Button>
                </div>
              </div>
            ) : (
              <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-600 dark:text-amber-400">
                {t('playlists.keyChanged')}
              </p>
            )}

            <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
              <p className="text-fg-muted">
                {tx('playlists.treatAsPassword', { b: (chunks) => <span className="font-medium text-fg">{chunks}</span>, em: (chunks) => <em>{chunks}</em> })}
              </p>
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="danger" onClick={() => setConfirming('off')}>
                {t('playlists.export.turnOff')}
              </Button>
              <Button icon={<RefreshCw className="h-4 w-4" />} onClick={() => setConfirming('replace')}>
                {t('playlists.export.createNew')}
              </Button>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirming === 'replace'}
        onClose={() => setConfirming(null)}
        title={t('playlists.export.replaceTitle')}
        description={t('playlists.export.replaceHint')}
        confirmLabel={t('playlists.export.replace')}
        tone="primary"
        onConfirm={() => enable.mutateAsync()}
      />
      <ConfirmDialog
        open={confirming === 'off'}
        onClose={() => setConfirming(null)}
        title={t('playlists.export.offTitle')}
        description={t('playlists.export.offHint')}
        confirmLabel={t('playlists.export.off')}
        onConfirm={() => disable.mutateAsync()}
      />
    </Dialog>
  );
}

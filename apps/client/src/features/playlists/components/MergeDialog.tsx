import type { PlaylistSummaryDto } from '@ziptv/contracts';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { errorMessage } from '../../../lib/api-client';
import { toggled } from '../selection';
import { useMergePlaylists, usePlaylists } from '../api';

interface MergeDialogProps {
  open: boolean;
  onClose: () => void;
  playlistId: string;
}

/** Copies the groups and channels of other playlists into this one (they stay as they are). */
export function MergeDialog({ open, onClose, playlistId }: MergeDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Merge playlists into this one" description="Groups are matched by name; channels already here are skipped. The other playlists stay untouched.">
      {open && <MergeForm onClose={onClose} playlistId={playlistId} />}
    </Dialog>
  );
}

function MergeForm({ onClose, playlistId }: Omit<MergeDialogProps, 'open'>) {
  const playlists = usePlaylists();
  const merge = useMergePlaylists(playlistId);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const others: PlaylistSummaryDto[] = (playlists.data ?? []).filter((playlist) => playlist.id !== playlistId);

  if (playlists.isPending) return <p className="py-6 text-center text-sm text-fg-muted">Loading…</p>;
  if (others.length === 0) return <p className="py-6 text-center text-sm text-fg-muted">You have no other playlists to merge.</p>;

  return (
    <div className="space-y-4">
      <ul className="max-h-72 space-y-1 overflow-y-auto">
        {others.map((playlist) => (
          <li key={playlist.id}>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-fg/5">
              <input type="checkbox" checked={chosen.has(playlist.id)} onChange={() => setChosen(toggled(chosen, playlist.id))} className="h-4 w-4 accent-brand" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">{playlist.name}</span>
                <span className="block text-xs text-fg-muted">
                  {playlist.entryCount.toLocaleString()} channels · {playlist.groupCount} groups
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {merge.error && (
        <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-500">
          {errorMessage(merge.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={merge.isPending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={merge.isPending}
          disabled={chosen.size === 0}
          onClick={async () => {
            try {
              const result = await merge.mutateAsync([...chosen]);
              toast.success(`${result.transferred.toLocaleString()} channels added`, { description: result.skipped > 0 ? `${result.skipped.toLocaleString()} were already here.` : undefined });
              onClose();
            } catch {
              /* shown above */
            }
          }}
        >
          Merge {chosen.size > 0 ? `(${chosen.size})` : ''}
        </Button>
      </div>
    </div>
  );
}

import type { PlaylistDto } from '@ziptv/contracts';
import { Check, FileText, Globe, Pencil, RefreshCw, Trash2, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { IconButton } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { errorMessage } from '../../../lib/api-client';
import { useDeletePlaylist, useRefreshPlaylist, useRenamePlaylist } from '../api';

interface ManagePlaylistsDialogProps {
  open: boolean;
  onClose: () => void;
  playlists: PlaylistDto[];
}

export function ManagePlaylistsDialog({ open, onClose, playlists }: ManagePlaylistsDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Your playlists" description="Stored on the ZIPTV server for this browser.">
      {playlists.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">No playlists yet.</p>
      ) : (
        <ul className="space-y-2">
          {playlists.map((playlist) => (
            <PlaylistRow key={playlist.id} playlist={playlist} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function PlaylistRow({ playlist }: { playlist: PlaylistDto }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(playlist.name);
  const [showWarnings, setShowWarnings] = useState(false);
  const rename = useRenamePlaylist();
  const refresh = useRefreshPlaylist();
  const remove = useDeletePlaylist();

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === playlist.name) {
      setEditing(false);
      setName(playlist.name);
      return;
    }
    try {
      await rename.mutateAsync({ id: playlist.id, name: trimmed });
      setEditing(false);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const doRefresh = async () => {
    try {
      const updated = await refresh.mutateAsync(playlist.id);
      toast.success(`“${updated.name}” refreshed`, { description: `${updated.stats.channels.toLocaleString()} channels` });
    } catch (error) {
      toast.error('Refresh failed', { description: errorMessage(error) });
    }
  };

  const doDelete = async () => {
    if (!window.confirm(`Delete “${playlist.name}”? This cannot be undone.`)) return;
    try {
      await remove.mutateAsync(playlist.id);
      toast.success(`“${playlist.name}” deleted`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const SourceIcon = playlist.source.type === 'url' ? Globe : FileText;

  return (
    <li className="rounded-xl border border-white/5 bg-white/[0.03] p-3">
      <div className="flex items-center gap-3">
        <SourceIcon className="h-5 w-5 shrink-0 text-slate-500" aria-hidden />
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                void saveName();
              }}
            >
              <input
                autoFocus
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                className="h-8 min-w-0 flex-1 rounded-md bg-ink-950 px-2 text-sm text-white ring-1 ring-inset ring-white/10 focus:outline-none focus:ring-brand"
                aria-label="Playlist name"
              />
              <IconButton label="Save name" type="submit" disabled={rename.isPending}>
                <Check className="h-4 w-4" />
              </IconButton>
              <IconButton
                label="Cancel"
                onClick={() => {
                  setEditing(false);
                  setName(playlist.name);
                }}
              >
                <X className="h-4 w-4" />
              </IconButton>
            </form>
          ) : (
            <p className="truncate text-sm font-medium text-white">{playlist.name}</p>
          )}
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {playlist.stats.channels.toLocaleString()} channels · {playlist.stats.groups} groups
            {playlist.stats.unplayable > 0 && ` · ${playlist.stats.unplayable} unplayable`} · updated{' '}
            {new Date(playlist.refreshedAt).toLocaleDateString()}
          </p>
        </div>
        {!editing && (
          <div className="flex shrink-0 items-center">
            {playlist.warningCount > 0 && (
              <IconButton label={`${playlist.warningCount} import warnings`} active={showWarnings} onClick={() => setShowWarnings((value) => !value)}>
                <TriangleAlert className="h-4 w-4 text-amber-400" />
              </IconButton>
            )}
            <IconButton label="Rename" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            {playlist.source.type === 'url' && (
              <IconButton label="Refresh from URL" onClick={() => void doRefresh()} disabled={refresh.isPending}>
                <RefreshCw className={refresh.isPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              </IconButton>
            )}
            <IconButton label="Delete" onClick={() => void doDelete()} disabled={remove.isPending} className="hover:text-red-300">
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      </div>
      {showWarnings && (
        <ul className="mt-3 max-h-40 space-y-0.5 overflow-y-auto rounded-md bg-ink-950/60 p-2 font-mono text-xs text-amber-200/80">
          {playlist.warnings.map((warning) => (
            <li key={`${warning.line}-${warning.code}-${warning.message}`}>
              line {warning.line}: {warning.message}
            </li>
          ))}
          {playlist.warningCount > playlist.warnings.length && (
            <li className="text-slate-500">…and {playlist.warningCount - playlist.warnings.length} more</li>
          )}
        </ul>
      )}
    </li>
  );
}

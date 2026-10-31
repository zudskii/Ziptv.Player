import type { PlaylistSummaryDto } from '@ziptv/contracts';
import { ChevronRight, Link2, ListVideo, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { Badge } from '../../components/ui/Badge';
import { Button, IconButton } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { FullscreenMessage } from '../../components/ui/FullscreenMessage';
import { PromptDialog } from '../../components/ui/PromptDialog';
import { Spinner } from '../../components/ui/Spinner';
import { errorMessage } from '../../lib/api-client';
import { useCreatePlaylist, useDeletePlaylist, usePlaylists } from '../../features/playlists/api';

/** Playlists: the channel lists the user builds from their sources and can open anywhere. */
export function PlaylistsPage() {
  const playlists = usePlaylists();
  const create = useCreatePlaylist();
  const remove = useDeletePlaylist();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<PlaylistSummaryDto | null>(null);
  const list = playlists.data ?? [];

  const newButton = (
    <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
      New playlist
    </Button>
  );

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-fg">Playlists</h1>
          <p className="mt-1 text-sm text-fg-muted">Pick channels from your sources, group, rename and number them, then open the result in any player with a link.</p>
        </div>
        {newButton}
      </header>

      {playlists.isPending ? (
        <Spinner className="py-16" label="Loading playlists…" />
      ) : playlists.isError ? (
        <FullscreenMessage tone="error" title="Couldn't load your playlists" description={errorMessage(playlists.error)} action={{ label: 'Try again', onClick: () => void playlists.refetch() }} />
      ) : list.length === 0 ? (
        <EmptyState icon={<ListVideo className="h-8 w-8" />} title="No playlists yet" description="A playlist is your own selection of channels, organised the way you like." action={newButton} />
      ) : (
        <ul className="space-y-3">
          {list.map((playlist) => (
            <li key={playlist.id} className="card flex items-center gap-3 p-4 hover:bg-fg/5">
              <Link to={`/playlists/${playlist.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                <ListVideo className="h-6 w-6 shrink-0 text-brand-soft" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-fg">{playlist.name}</span>
                  <span className="block truncate text-xs text-fg-muted">
                    {playlist.entryCount.toLocaleString()} channels · {playlist.groupCount} {playlist.groupCount === 1 ? 'group' : 'groups'}
                  </span>
                </span>
                {playlist.exportEnabled && (
                  <Badge tone="success" icon={<Link2 className="h-3 w-3" />}>
                    Link on
                  </Badge>
                )}
                <ChevronRight className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
              </Link>
              <IconButton label={`Delete ${playlist.name}`} onClick={() => setDeleting(playlist)}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <PromptDialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New playlist"
        label="Name"
        placeholder="e.g. Family, Sports, My favourites"
        submitLabel="Create"
        onSubmit={async (name) => {
          const created = await create.mutateAsync(name);
          navigate(`/playlists/${created.id}`);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description={
          <>
            Its {deleting?.entryCount.toLocaleString()} channels are removed from this playlist, and its link stops working. Your sources are not affected.
          </>
        }
        confirmLabel="Delete playlist"
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          toast.success(`“${deleting.name}” deleted`);
        }}
      />
    </div>
  );
}

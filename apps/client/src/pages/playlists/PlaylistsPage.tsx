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
import { t } from '../../i18n';

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
      {t('playlists.new')}
    </Button>
  );

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-fg">{t('playlists.title')}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t('playlists.intro')}</p>
        </div>
        {newButton}
      </header>

      {playlists.isPending ? (
        <Spinner className="py-16" label={t('playlists.loading')} />
      ) : playlists.isError ? (
        <FullscreenMessage tone="error" title={t('playlists.loadFailed')} description={errorMessage(playlists.error)} action={{ label: t('playlists.retry'), onClick: () => void playlists.refetch() }} />
      ) : list.length === 0 ? (
        <EmptyState icon={<ListVideo className="h-8 w-8" />} title={t('playlists.none')} description={t('playlists.noneHint')} action={newButton} />
      ) : (
        <ul className="space-y-3">
          {list.map((playlist) => (
            <li key={playlist.id} className="card flex items-center gap-3 p-4 hover:bg-fg/5">
              <Link to={`/playlists/${playlist.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                <ListVideo className="h-6 w-6 shrink-0 text-brand-soft" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-fg">{playlist.name}</span>
                  <span className="block truncate text-xs text-fg-muted">
                    {t('playlists.count.channelsGroups', { channels: playlist.entryCount, groups: playlist.groupCount })}
                  </span>
                </span>
                {playlist.exportEnabled && (
                  <Badge tone="success" icon={<Link2 className="h-3 w-3" />}>
                    {t('playlists.linkOn')}
                  </Badge>
                )}
                <ChevronRight className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
              </Link>
              <IconButton label={t('playlists.deleteNamed', { name: playlist.name })} onClick={() => setDeleting(playlist)}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <PromptDialog
        open={creating}
        onClose={() => setCreating(false)}
        title={t('playlists.new')}
        label={t('playlists.name')}
        placeholder={t('playlists.namePlaceholder')}
        submitLabel={t('playlists.create')}
        onSubmit={async (name) => {
          const created = await create.mutateAsync(name);
          navigate(`/playlists/${created.id}`);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t('playlists.deleteTitle', { name: deleting?.name ?? '' })}
        description={
          <>
            {t('playlists.deleteHint', { count: deleting?.entryCount ?? 0 })}
          </>
        }
        confirmLabel={t('playlists.delete')}
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          toast.success(`“${deleting.name}” deleted`);
        }}
      />
    </div>
  );
}

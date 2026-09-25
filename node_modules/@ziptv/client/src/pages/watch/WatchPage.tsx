import type { PlaylistDto } from '@ziptv/contracts';
import { FileUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { Button } from '../../components/ui/Button';
import { FullscreenMessage } from '../../components/ui/FullscreenMessage';
import { Spinner } from '../../components/ui/Spinner';
import { errorMessage } from '../../lib/api-client';
import { usePlayerPrefs } from '../../features/player/player-prefs';
import { usePlaylists } from '../../features/playlists/api';
import { AddPlaylistDialog } from '../../features/playlists/components/AddPlaylistDialog';
import { ManagePlaylistsDialog } from '../../features/playlists/components/ManagePlaylistsDialog';
import { WatchHeader } from './WatchHeader';
import { WatchWorkspace } from './WatchWorkspace';

/** /watch[/:playlistId[/:channelKey]] — playlist selection + dialogs; the rest lives in WatchWorkspace. */
export function WatchPage() {
  const { playlistId, channelKey } = useParams();
  const navigate = useNavigate();
  const playlistsQuery = usePlaylists();
  const activePlaylistId = usePlayerPrefs((state) => state.activePlaylistId);
  const setActivePlaylist = usePlayerPrefs((state) => state.setActivePlaylist);
  const [dialog, setDialog] = useState<'add' | 'manage' | null>(null);

  const playlists = playlistsQuery.data ?? [];
  const playlist = pickPlaylist(playlists, playlistId, activePlaylistId);

  // Keep the URL canonical (/watch → /watch/:id[/:lastChannel]) and remember the choice.
  useEffect(() => {
    if (!playlist) return;
    if (playlist.id !== activePlaylistId) setActivePlaylist(playlist.id);
    if (playlist.id !== playlistId) {
      const resume = usePlayerPrefs.getState().lastChannel[playlist.id];
      navigate(`/watch/${playlist.id}${resume ? `/${resume}` : ''}`, { replace: true });
    }
  }, [playlist, playlistId, activePlaylistId, setActivePlaylist, navigate]);

  const openPlaylist = (id: string) => {
    const resume = usePlayerPrefs.getState().lastChannel[id];
    navigate(`/watch/${id}${resume ? `/${resume}` : ''}`);
  };

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <WatchHeader
        playlists={playlists}
        activePlaylistId={playlist?.id}
        onSelectPlaylist={openPlaylist}
        onAdd={() => setDialog('add')}
        onManage={() => setDialog('manage')}
      />

      {playlistsQuery.isPending ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner label="Loading your playlists…" />
        </div>
      ) : playlistsQuery.isError ? (
        <FullscreenMessage
          tone="error"
          title="Couldn't load your playlists"
          description={errorMessage(playlistsQuery.error)}
          action={{ label: 'Try again', onClick: () => void playlistsQuery.refetch() }}
        />
      ) : !playlist ? (
        <FullscreenMessage
          title="Add your first playlist"
          description="Upload an .m3u / .m3u8 file or paste your provider's playlist URL. Everything stays private to this browser."
        >
          <Button variant="primary" size="lg" className="mt-6" icon={<FileUp className="h-5 w-5" />} onClick={() => setDialog('add')}>
            Add playlist
          </Button>
        </FullscreenMessage>
      ) : (
        <WatchWorkspace key={playlist.id} playlist={playlist} channelKey={playlist.id === playlistId ? channelKey : undefined} />
      )}

      <AddPlaylistDialog
        open={dialog === 'add'}
        onClose={() => setDialog(null)}
        onAdded={(added) => {
          setDialog(null);
          navigate(`/watch/${added.id}`);
        }}
      />
      <ManagePlaylistsDialog open={dialog === 'manage'} onClose={() => setDialog(null)} playlists={playlists} />
    </div>
  );
}

function pickPlaylist(playlists: PlaylistDto[], fromUrl: string | undefined, remembered: string | null): PlaylistDto | undefined {
  return playlists.find((p) => p.id === fromUrl) ?? playlists.find((p) => p.id === remembered) ?? playlists[0];
}

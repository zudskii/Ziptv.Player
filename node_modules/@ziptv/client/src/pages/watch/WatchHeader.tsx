import type { PlaylistDto } from '@ziptv/contracts';
import { ListVideo, Plus, Settings2 } from 'lucide-react';

import { Brand } from '../../components/layout/Brand';
import { Button } from '../../components/ui/Button';

interface WatchHeaderProps {
  playlists: PlaylistDto[];
  activePlaylistId: string | undefined;
  onSelectPlaylist: (playlistId: string) => void;
  onAdd: () => void;
  onManage: () => void;
}

export function WatchHeader({ playlists, activePlaylistId, onSelectPlaylist, onAdd, onManage }: WatchHeaderProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-white/5 bg-ink-900/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-3 sm:px-5">
        <Brand compact />
        {playlists.length > 0 && (
          <label className="relative min-w-0 max-w-xs flex-1">
            <span className="sr-only">Playlist</span>
            <ListVideo className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <select
              value={activePlaylistId ?? ''}
              onChange={(event) => onSelectPlaylist(event.target.value)}
              className="h-9 w-full appearance-none truncate rounded-lg bg-white/5 pl-8 pr-3 text-sm font-medium text-white ring-1 ring-inset ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand"
            >
              {playlists.map((playlist) => (
                <option key={playlist.id} value={playlist.id}>
                  {playlist.name} ({playlist.stats.channels.toLocaleString()})
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ml-auto flex items-center gap-2">
          {playlists.length > 0 && (
            <Button variant="ghost" size="sm" icon={<Settings2 className="h-4 w-4" />} onClick={onManage}>
              <span className="hidden sm:inline">Manage</span>
            </Button>
          )}
          <Button variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={onAdd}>
            <span className="hidden sm:inline">Add playlist</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

import type { PlaylistDto } from '@ziptv/contracts';
import { Star } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { errorMessage } from '../../lib/api-client';
import { cn } from '../../lib/cn';
import { buildGroupOptions, neighbourChannel, selectChannels, toBrowsable, type BrowsableChannel, type GroupFilterValue } from '../../features/channels/browse';
import { ChannelBrowser } from '../../features/channels/components/ChannelBrowser';
import { ChannelLogo } from '../../features/channels/components/ChannelLogo';
import { useFavorites, useLibraryStore, useRecents } from '../../features/library/library-store';
import { VideoPlayer } from '../../features/player/components/VideoPlayer';
import { usePlayerPrefs } from '../../features/player/player-prefs';
import { useChannelList } from '../../features/playlists/api';

interface WatchWorkspaceProps {
  playlist: PlaylistDto;
  channelKey: string | undefined;
}

/**
 * Everything scoped to one playlist. Mounted with `key={playlist.id}`, so switching playlists
 * resets filters/search naturally instead of via effects.
 */
export function WatchWorkspace({ playlist, channelKey }: WatchWorkspaceProps) {
  const navigate = useNavigate();
  const channelsQuery = useChannelList(playlist);
  const favoriteKeys = useFavorites(playlist.id);
  const recentKeys = useRecents(playlist.id);
  const toggleFavorite = useLibraryStore((state) => state.toggleFavorite);
  const pushRecent = useLibraryStore((state) => state.pushRecent);
  const rememberChannel = usePlayerPrefs((state) => state.rememberChannel);

  const [group, setGroup] = useState<GroupFilterValue>('all');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);

  const channels = useMemo(() => toBrowsable(channelsQuery.data?.channels ?? []), [channelsQuery.data]);
  const byKey = useMemo(() => new Map(channels.map((channel) => [channel.key, channel])), [channels]);
  const favorites = useMemo(() => new Set(favoriteKeys), [favoriteKeys]);
  const recentCount = useMemo(() => recentKeys.filter((key) => byKey.has(key)).length, [recentKeys, byKey]);
  const favoriteCount = useMemo(() => favoriteKeys.filter((key) => byKey.has(key)).length, [favoriteKeys, byKey]);

  const groupOptions = useMemo(() => buildGroupOptions(channels, favoriteCount, recentCount), [channels, favoriteCount, recentCount]);
  const visible = useMemo(
    () => selectChannels(channels, { group, search: deferredSearch, favorites, recents: recentKeys }),
    [channels, group, deferredSearch, favorites, recentKeys],
  );

  const current = channelKey ? byKey.get(channelKey) : undefined;

  // History: remember what was watched (for "Recently watched" and resume).
  useEffect(() => {
    if (!current) return;
    pushRecent(playlist.id, current.key);
    rememberChannel(playlist.id, current.key);
  }, [current, playlist.id, pushRecent, rememberChannel]);

  const select = useCallback(
    (channel: BrowsableChannel | undefined) => {
      if (channel) navigate(`/watch/${playlist.id}/${channel.key}`);
    },
    [navigate, playlist.id],
  );
  // Zapping follows the visible list, but falls back to the whole playlist when filtered out.
  const zapList = visible.length > 0 ? visible : channels;
  const next = useCallback(() => select(neighbourChannel(zapList, channelKey, 1)), [select, zapList, channelKey]);
  const previous = useCallback(() => select(neighbourChannel(zapList, channelKey, -1)), [select, zapList, channelKey]);

  const missingChannel = Boolean(channelKey && channelsQuery.isSuccess && !current);

  return (
    <div className="mx-auto grid w-full max-w-[1600px] flex-1 gap-4 p-3 sm:p-5 lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
      <section className="flex min-w-0 flex-col gap-3 lg:overflow-y-auto" aria-label="Player">
        <div className="sticky top-14 z-20 lg:static">
          <VideoPlayer playlistId={playlist.id} channel={current} onNext={next} onPrevious={previous} />
        </div>

        {current ? (
          <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-ink-850/80 p-3">
            <ChannelLogo key={current.key} playlistId={playlist.id} channel={current} className="h-12 w-16" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold text-white">{current.name}</h1>
              <p className="truncate text-sm text-slate-400">
                {current.groups.length > 0 ? current.groups.join(' · ') : 'Uncategorized'}
                <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  {current.kind === 'unknown' ? 'auto' : current.kind}
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => toggleFavorite(playlist.id, current.key)}
              aria-pressed={favorites.has(current.key)}
              className={cn(
                'inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium ring-1 ring-inset transition-colors',
                favorites.has(current.key) ? 'bg-amber-400/10 text-amber-300 ring-amber-400/30' : 'text-slate-300 ring-white/10 hover:bg-white/5',
              )}
            >
              <Star className={cn('h-4 w-4', favorites.has(current.key) && 'fill-current')} />
              <span className="hidden sm:inline">{favorites.has(current.key) ? 'Favorite' : 'Add to favorites'}</span>
            </button>
          </div>
        ) : missingChannel ? (
          <p className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-200">
            This channel is no longer in “{playlist.name}” (the playlist may have been refreshed). Pick another one.
          </p>
        ) : null}

        <p className="hidden text-xs text-slate-500 lg:block">
          Shortcuts: <Kbd>Space</Kbd> play/pause · <Kbd>M</Kbd> mute · <Kbd>F</Kbd> fullscreen · <Kbd>↑</Kbd>/<Kbd>↓</Kbd> volume · <Kbd>N</Kbd>/
          <Kbd>P</Kbd> next/previous channel
        </p>
      </section>

      <div className="h-[70vh] min-h-0 lg:h-auto">
        <ChannelBrowser
          playlistId={playlist.id}
          loading={channelsQuery.isPending}
          error={channelsQuery.isError ? errorMessage(channelsQuery.error) : null}
          groupOptions={groupOptions}
          group={group}
          search={search}
          channels={visible}
          activeKey={channelKey}
          favorites={favorites}
          onGroupChange={setGroup}
          onSearchChange={setSearch}
          onSelect={select}
          onToggleFavorite={(channel) => toggleFavorite(playlist.id, channel.key)}
          onRetry={() => void channelsQuery.refetch()}
        />
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-white/10 bg-white/5 px-1 py-px font-mono text-[10px] text-slate-300">{children}</kbd>;
}

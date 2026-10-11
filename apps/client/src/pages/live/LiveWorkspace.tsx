import type { ContentRefDto, SourceDto } from '@ziptv/contracts';
import { Server, Star } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { Badge } from '../../components/ui/Badge';
import { errorMessage } from '../../lib/api-client';
import { cn } from '../../lib/cn';
import { buildGroupOptions, neighbourChannel, selectChannels, toBrowsable, type BrowsableChannel, type GroupFilterValue } from '../../features/live/browse';
import { ChannelBrowser } from '../../features/live/components/ChannelBrowser';
import { ChannelLogo } from '../../features/live/components/ChannelLogo';
import { useFavorites, useLibraryStore, useRecents } from '../../features/library/library-store';
import { VideoPlayer } from '../../features/player/components/VideoPlayer';
import { usePlayerPrefs } from '../../features/player/player-prefs';
import { useChannelList } from '../../features/sources/api';

interface LiveWorkspaceProps {
  source: SourceDto;
  sources: SourceDto[];
  channelKey: string | undefined;
  onSelectSource: (sourceId: string) => void;
}

/**
 * Live TV for one source: groups, search, favorites, recent, channel list and the player.
 * Mounted with `key={source.id}`, so switching sources resets filters naturally.
 */
export function LiveWorkspace({ source, sources, channelKey, onSelectSource }: LiveWorkspaceProps) {
  const navigate = useNavigate();
  const channelsQuery = useChannelList(source);
  const favoriteKeys = useFavorites(source.id);
  const recentKeys = useRecents(source.id);
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
  const content: ContentRefDto | undefined = useMemo(() => (current ? { type: 'channel', sourceId: source.id, key: current.key } : undefined), [current, source.id]);

  // History: remember what was watched (for "Recent" and resume).
  useEffect(() => {
    if (!current) return;
    pushRecent(source.id, current.key);
    rememberChannel(source.id, current.key);
  }, [current, source.id, pushRecent, rememberChannel]);

  const select = useCallback(
    (channel: BrowsableChannel | undefined) => {
      if (channel) navigate(`/live/${source.id}/${channel.key}`);
    },
    [navigate, source.id],
  );
  // Zapping follows the visible list, but falls back to the whole source when filtered out.
  const zapList = visible.length > 0 ? visible : channels;
  const next = useCallback(() => select(neighbourChannel(zapList, channelKey, 1)), [select, zapList, channelKey]);
  const previous = useCallback(() => select(neighbourChannel(zapList, channelKey, -1)), [select, zapList, channelKey]);

  const missingChannel = Boolean(channelKey && channelsQuery.isSuccess && !current);

  return (
    <div className="mx-auto grid w-full max-w-[1600px] gap-4 p-3 sm:p-5 lg:h-[calc(100dvh-3.5rem)] lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
      <section className="flex min-w-0 flex-col gap-3 lg:overflow-y-auto" aria-label="Player">
        <div className="sticky top-14 z-20 lg:static">
          <VideoPlayer
            content={content}
            title={current?.name}
            onNext={next}
            onPrevious={previous}
            onAlternate={(ref) => {
              if (ref.type === 'channel') navigate(`/live/${ref.sourceId}/${ref.key}`);
            }}
            onBack={() => navigate(`/live/${source.id}`)}
          />
        </div>

        {current ? (
          <div className="card flex items-center gap-3 p-3">
            <ChannelLogo sourceId={source.id} channel={current} className="h-12 w-16" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold text-fg">{current.name}</h1>
              <p className="flex flex-wrap items-center gap-2 truncate text-sm text-fg-muted">
                {current.groups.length > 0 ? current.groups.join(' · ') : 'Uncategorized'}
                <Badge>{current.kind === 'unknown' ? 'auto' : current.kind}</Badge>
                {current.catchupDays && <Badge tone="brand">Archive {current.catchupDays}d</Badge>}
              </p>
            </div>
            <FavoriteButton active={favorites.has(current.key)} onClick={() => toggleFavorite(source.id, current.key)} />
          </div>
        ) : missingChannel ? (
          <p className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-600">
            This channel is no longer in “{source.name}” (the source may have been re-synced). Pick another one.
          </p>
        ) : null}

        <p className="hidden text-xs text-fg-subtle lg:block">
          Shortcuts: <Kbd>Space</Kbd> play/pause · <Kbd>M</Kbd> mute · <Kbd>F</Kbd> fullscreen · <Kbd>↑</Kbd>/<Kbd>↓</Kbd> volume · <Kbd>N</Kbd>/<Kbd>P</Kbd> next/previous channel
        </p>
      </section>

      <div className="flex h-[70vh] min-h-0 flex-col gap-3 lg:h-auto">
        {sources.length > 1 && (
          <label className="relative block">
            <span className="sr-only">Source</span>
            <Server className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <select value={source.id} onChange={(event) => onSelectSource(event.target.value)} className="field appearance-none pl-9">
              {sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.stats.live.toLocaleString()})
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="min-h-0 flex-1">
          <ChannelBrowser
            sourceId={source.id}
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
            onToggleFavorite={(channel) => toggleFavorite(source.id, channel.key)}
            onRetry={() => void channelsQuery.refetch()}
          />
        </div>
      </div>
    </div>
  );
}

function FavoriteButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium ring-1 ring-inset transition-colors',
        active ? 'bg-amber-400/10 text-amber-500 ring-amber-400/30' : 'text-fg-muted ring-line/10 hover:bg-fg/5',
      )}
    >
      <Star className={cn('h-4 w-4', active && 'fill-current')} />
      <span className="hidden sm:inline">{active ? 'Favorite' : 'Add to favorites'}</span>
    </button>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line/10 bg-fg/5 px-1 py-px font-mono text-[10px] text-fg-muted">{children}</kbd>;
}

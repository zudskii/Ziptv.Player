import type { ContentRefDto, ProgrammeDto, SourceDto } from '@ziptv/contracts';
import { CalendarDays, List, Server } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router';

import { Segmented } from '../../components/ui/Segmented';
import { errorMessage } from '../../lib/api-client';
import { useIsDesktop } from '../../lib/use-media-query';
import { useNowNext } from '../../features/epg/api';
import { EpgMappingDialog } from '../../features/epg/components/EpgMappingDialog';
import { LiveInfoOverlay, LiveNowCard } from '../../features/epg/components/LiveNowCard';
import { MiniGuide } from '../../features/epg/components/MiniGuide';
import { ProgrammeDialog } from '../../features/epg/components/ProgrammeDialog';
import { buildGroupOptions, neighbourChannel, selectChannels, toBrowsable, type BrowsableChannel, type GroupFilterValue } from '../../features/live/browse';
import { ChannelBrowser } from '../../features/live/components/ChannelBrowser';
import { useLibraryStore, useRecents } from '../../features/library/library-store';
import { useListKeys, useToggleListItem } from '../../features/user-state/api';
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
  // Favourites are My List channels (per profile, on the server); "Recent" stays per device.
  const favorites = useListKeys(source.id, 'channel');
  const toggleList = useToggleListItem();
  const toggleFavorite = useCallback(
    (key: string) =>
      toggleList.mutate(
        { item: { type: 'channel', sourceId: source.id, key }, add: !favorites.has(key) },
        { onError: (error) => toast.error('My List was not updated', { description: errorMessage(error) }) },
      ),
    [toggleList, source.id, favorites],
  );
  const recentKeys = useRecents(source.id);
  const pushRecent = useLibraryStore((state) => state.pushRecent);
  const rememberChannel = usePlayerPrefs((state) => state.rememberChannel);

  const nowNextQuery = useNowNext(source);
  const nowNext = nowNextQuery.data?.items;
  const isDesktop = useIsDesktop();
  const [panel, setPanel] = useState<'channels' | 'guide'>('channels');
  const [programme, setProgramme] = useState<ProgrammeDto | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);

  const [group, setGroup] = useState<GroupFilterValue>('all');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);

  const channels = useMemo(() => toBrowsable(channelsQuery.data?.channels ?? []), [channelsQuery.data]);
  const byKey = useMemo(() => new Map(channels.map((channel) => [channel.key, channel])), [channels]);
  const recentCount = useMemo(() => recentKeys.filter((key) => byKey.has(key)).length, [recentKeys, byKey]);
  const favoriteCount = useMemo(() => [...favorites].filter((key) => byKey.has(key)).length, [favorites, byKey]);

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
            infoOverlay={current ? <LiveInfoOverlay sourceId={source.id} channel={current} entry={nowNext?.[current.key]} /> : undefined}
          />
        </div>

        {current ? (
          <>
            <LiveNowCard
              sourceId={source.id}
              channel={current}
              entry={nowNext?.[current.key]}
              favorite={favorites.has(current.key)}
              onToggleFavorite={() => toggleFavorite(current.key)}
              onOpenMapping={() => setMappingOpen(true)}
              onSelectProgramme={setProgramme}
            />
            {isDesktop && (
              <section className="card flex min-h-[16rem] flex-col p-2" aria-label="Mini guide">
                <h2 className="flex items-center gap-2 px-2 pb-2 pt-1 text-sm font-semibold text-fg">
                  <CalendarDays className="h-4 w-4 text-brand-soft" /> Schedule
                </h2>
                <MiniGuide source={source} channel={current} onSelect={setProgramme} className="max-h-[28rem] min-h-0 flex-1" />
              </section>
            )}
          </>
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
        {!isDesktop && current && (
          <Segmented
            label="Panel"
            value={panel}
            onChange={setPanel}
            options={[
              { value: 'channels', label: 'Channels', icon: <List className="h-4 w-4" /> },
              { value: 'guide', label: 'Guide', icon: <CalendarDays className="h-4 w-4" /> },
            ]}
          />
        )}
        {!isDesktop && current && panel === 'guide' ? (
          <div className="card min-h-0 flex-1 p-2">
            <MiniGuide source={source} channel={current} onSelect={setProgramme} className="h-full" />
          </div>
        ) : (
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
            nowNext={nowNext}
            onGroupChange={setGroup}
            onSearchChange={setSearch}
            onSelect={select}
            onToggleFavorite={(channel) => toggleFavorite(channel.key)}
            onRetry={() => void channelsQuery.refetch()}
          />
        </div>
        )}
      </div>

      <ProgrammeDialog
        programme={programme}
        channel={current ?? null}
        onClose={() => setProgramme(null)}
        onWatchLive={() => setProgramme(null)}
      />
      <EpgMappingDialog key={current?.key ?? 'none'} sourceId={source.id} channel={mappingOpen && current ? current : null} onClose={() => setMappingOpen(false)} />
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line/10 bg-fg/5 px-1 py-px font-mono text-[10px] text-fg-muted">{children}</kbd>;
}

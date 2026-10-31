import { useVirtualizer } from '@tanstack/react-virtual';
import type { PlaylistDto, SourceDto } from '@ziptv/contracts';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Segmented } from '../../../components/ui/Segmented';
import { Spinner } from '../../../components/ui/Spinner';
import { errorMessage } from '../../../lib/api-client';
import { buildGroupOptions, selectChannels, toBrowsable } from '../../live/browse';
import { useChannelList, useSources } from '../../sources/api';
import { useAddFromSource, useCreateGroup } from '../api';
import { buildPlacement, buildSelection, countSelected, findGroupByName, selectionProblem, type AddMode } from '../add-request';
import { isChoiceReady, NO_GROUP, type GroupChoice } from '../group-choice';
import { toggled } from '../selection';
import { GroupPicker } from './GroupPicker';

interface AddChannelsDialogProps {
  open: boolean;
  onClose: () => void;
  playlist: PlaylistDto;
}

/** Pick channels from one of your sources: all of them, whole groups, or single channels. */
export function AddChannelsDialog({ open, onClose, playlist }: AddChannelsDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Add channels" description="Channels already in this playlist are skipped, so you can add a source again later to pick up its new channels." className="w-[min(94vw,40rem)]">
      {open && <AddForm onClose={onClose} playlist={playlist} />}
    </Dialog>
  );
}

function AddForm({ onClose, playlist }: { onClose: () => void; playlist: PlaylistDto }) {
  const sources = useSources();
  const ready = (sources.data ?? []).filter((source) => source.revision > 0);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const source = ready.find((item) => item.id === sourceId) ?? ready[0];

  if (sources.isPending) return <Spinner className="py-8" />;
  if (ready.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-fg-muted">
        You have no loaded sources yet. <Link to="/sources" className="font-medium text-brand-soft hover:underline">Add a source</Link> first.
      </p>
    );
  }
  return <SourcePicker key={source!.id} sources={ready} source={source!} onSourceChange={setSourceId} playlist={playlist} onClose={onClose} />;
}

function SourcePicker({ sources, source, onSourceChange, playlist, onClose }: { sources: SourceDto[]; source: SourceDto; onSourceChange: (id: string) => void; playlist: PlaylistDto; onClose: () => void }) {
  const list = useChannelList(source);
  const add = useAddFromSource(playlist.id);
  const createGroup = useCreateGroup(playlist.id);
  const [mode, setMode] = useState<AddMode>('all');
  const [groups, setGroups] = useState<ReadonlySet<string>>(new Set());
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState('');
  const [keepGroups, setKeepGroups] = useState(true);
  const [choice, setChoice] = useState<GroupChoice>(NO_GROUP);
  const [error, setError] = useState<string | null>(null);

  const channels = useMemo(() => list.data?.channels ?? [], [list.data]);
  const browsable = useMemo(() => toBrowsable(channels), [channels]);
  const groupOptions = useMemo(() => buildGroupOptions(channels, 0, 0).filter((option) => option.value.startsWith('g:')), [channels]);
  const picks = { groups, keys };
  const count = countSelected(channels, mode, picks);
  const problem = selectionProblem(mode, picks, channels.length);
  const pending = add.isPending || createGroup.isPending;
  const canSubmit = !problem && (keepGroups || isChoiceReady(choice));

  const submit = async () => {
    setError(null);
    try {
      let groupId: string | null = null;
      if (!keepGroups && choice.type === 'group') groupId = choice.groupId;
      if (!keepGroups && choice.type === 'new') groupId = (findGroupByName(playlist.groups, choice.name) ?? (await createGroup.mutateAsync(choice.name.trim()))).id;
      const result = await add.mutateAsync({ sourceId: source.id, select: buildSelection(mode, picks), placement: buildPlacement(keepGroups, groupId) });
      toast.success(`${result.added.toLocaleString()} ${result.added === 1 ? 'channel' : 'channels'} added`, { description: result.skipped > 0 ? `${result.skipped.toLocaleString()} were already in the playlist.` : undefined });
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="space-y-5">
      {sources.length > 1 && (
        <div className="space-y-1.5">
          <label htmlFor="add-source" className="text-sm text-fg-muted">
            Source
          </label>
          <select id="add-source" value={source.id} onChange={(event) => onSourceChange(event.target.value)} className="field">
            {sources.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.stats.live.toLocaleString()} channels)
              </option>
            ))}
          </select>
        </div>
      )}

      {list.isPending ? (
        <Spinner className="py-8" label="Loading channels…" />
      ) : list.isError ? (
        <p role="alert" className="text-sm text-red-500">
          {errorMessage(list.error)}
        </p>
      ) : (
        <>
          <Segmented
            label="What to add"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'all', label: `Everything (${channels.length.toLocaleString()})` },
              { value: 'groups', label: 'Groups' },
              { value: 'channels', label: 'Channels' },
            ]}
          />

          {mode === 'groups' &&
            (groupOptions.length === 0 ? (
              <p className="text-sm text-fg-muted">This source has no groups. Add everything, or pick channels.</p>
            ) : (
              <div>
                <div className="mb-1 flex justify-end gap-3 text-xs">
                  <button type="button" className="text-brand-soft hover:underline" onClick={() => setGroups(new Set(groupOptions.map((option) => option.label)))}>
                    Select all
                  </button>
                  <button type="button" className="text-brand-soft hover:underline" onClick={() => setGroups(new Set())}>
                    None
                  </button>
                </div>
                <ul className="max-h-60 space-y-0.5 overflow-y-auto rounded-lg border border-line/5 p-1">
                  {groupOptions.map((option) => (
                    <li key={option.value}>
                      <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-fg/5">
                        <input type="checkbox" checked={groups.has(option.label)} onChange={() => setGroups(toggled(groups, option.label))} className="h-4 w-4 accent-brand" />
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">{option.label}</span>
                        <span className="text-xs tabular-nums text-fg-subtle">{option.count.toLocaleString()}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

          {mode === 'channels' && <ChannelPicker channels={browsable} keys={keys} onKeys={setKeys} search={search} onSearch={setSearch} />}

          <div className="space-y-2">
            <p className="text-sm text-fg-muted">Where they go</p>
            <Segmented label="Where they go" size="sm" value={keepGroups ? 'keep' : 'one'} onChange={(value) => setKeepGroups(value === 'keep')} options={[{ value: 'keep', label: "Keep the source's groups" }, { value: 'one', label: 'Put into one group' }]} />
            {!keepGroups && <GroupPicker groups={playlist.groups} value={choice} onChange={setChoice} />}
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">{list.data && !problem ? `${count.toLocaleString()} ${count === 1 ? 'channel' : 'channels'}` : (problem && list.data ? problem : '')}</p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} disabled={!canSubmit || !list.data} onClick={submit}>
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Searchable, virtualised checklist of a source's channels. */
function ChannelPicker({ channels, keys, onKeys, search, onSearch }: { channels: ReturnType<typeof toBrowsable>; keys: ReadonlySet<string>; onKeys: (keys: ReadonlySet<string>) => void; search: string; onSearch: (value: string) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => selectChannels(channels, { group: 'all', search, favorites: new Set(), recents: [] }), [channels, search]);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is designed for this usage.
  const virtualizer = useVirtualizer({ count: shown.length, getScrollElement: () => scrollRef.current, estimateSize: () => 36, overscan: 12 });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search channels" aria-label="Search channels" className="field" />
        <Button size="sm" onClick={() => onKeys(new Set([...keys, ...shown.map((channel) => channel.key)]))} disabled={shown.length === 0}>
          Select {shown.length.toLocaleString()}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onKeys(new Set())} disabled={keys.size === 0}>
          Clear
        </Button>
      </div>
      <div ref={scrollRef} className="scrollbar-thin h-60 overflow-y-auto rounded-lg border border-line/5">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const channel = shown[item.index];
            if (!channel) return null;
            return (
              <label key={channel.key} className="absolute left-0 top-0 flex w-full cursor-pointer items-center gap-3 px-3 hover:bg-fg/5" style={{ height: item.size, transform: `translateY(${item.start}px)` }}>
                <input type="checkbox" checked={keys.has(channel.key)} onChange={() => onKeys(toggled(keys, channel.key))} className="h-4 w-4 shrink-0 accent-brand" />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{channel.name}</span>
                {channel.groups[0] && <span className="max-w-[10rem] shrink-0 truncate text-xs text-fg-subtle">{channel.groups[0]}</span>}
              </label>
            );
          })}
        </div>
      </div>
      <p className="text-xs text-fg-subtle">{keys.size.toLocaleString()} selected</p>
    </div>
  );
}

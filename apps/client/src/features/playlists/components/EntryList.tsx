import { useVirtualizer } from '@tanstack/react-virtual';
import type { PlaylistEntryDto } from '@ziptv/contracts';
import { GripVertical, Pencil, SearchX, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Badge } from '../../../components/ui/Badge';
import { IconButton } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { FullscreenMessage } from '../../../components/ui/FullscreenMessage';
import { Img, Initials } from '../../../components/ui/Img';
import { Spinner } from '../../../components/ui/Spinner';
import { errorMessage } from '../../../lib/api-client';
import { cn } from '../../../lib/cn';
import { catalogImageProxy, imageSources } from '../../../lib/images';
import { usePlaylistEntries } from '../api';
import { hasDrag, readDrag, writeDrag } from '../drag';
import type { EntryFilter } from '../entry-filter';
import { idsInRange, idsToDrag } from '../selection';
import { t } from '../../../i18n';

const ROW_HEIGHT = 60;

interface EntryListProps {
  playlistId: string;
  filter: EntryFilter;
  groupNames: ReadonlyMap<string, string>;
  selected: ReadonlySet<string>;
  /** Replaces the selection (a click toggles one id; shift-click adds a range). */
  onSelect: (next: (current: ReadonlySet<string>) => ReadonlySet<string>) => void;
  onEdit: (entry: PlaylistEntryDto) => void;
  onRemove: (entry: PlaylistEntryDto) => void;
  /** Entries dropped on a row: they go into that row's group, before it. */
  onDropBefore: (target: PlaylistEntryDto, ids: string[]) => void;
}

/** Virtualised, server-paged: 50 000 entries scroll as smoothly as 50, and only visible pages are fetched. */
export function EntryList({ playlistId, filter, groupNames, selected, onSelect, onEdit, onRemove, onDropBefore }: EntryListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ first: 0, last: 30 });
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const lastClicked = useRef<number | null>(null);
  const { total, entryAt, isPending, isError, error, refetch } = usePlaylistEntries(playlistId, filter, range);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is designed for this usage.
  const virtualizer = useVirtualizer({ count: total ?? 0, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_HEIGHT, overscan: 10 });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;

  useEffect(() => {
    setRange((current) => (current.first === first && current.last === last ? current : { first, last }));
  }, [first, last]);

  // A different filter is a different list: start from the top.
  useEffect(() => {
    virtualizer.scrollToOffset(0);
    lastClicked.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistId, filter.scope.type, filter.scope.type === 'group' ? filter.scope.groupId : '', filter.search, filter.missingOnly]);

  if (isPending) return <Spinner className="py-16" label={t('playlists.loadingChannels')} />;
  if (isError) return <FullscreenMessage tone="error" title={t('playlists.list.loadFailed')} description={errorMessage(error)} action={{ label: t('playlists.retry'), onClick: () => void refetch() }} />;
  if (total === 0) {
    return filter.search || filter.missingOnly || filter.scope.type !== 'all' ? (
      <EmptyState className="m-4" icon={<SearchX className="h-8 w-8" />} title={t('playlists.list.empty')} description={t('playlists.list.emptyHint')} />
    ) : (
      <EmptyState className="m-4" icon={<SearchX className="h-8 w-8" />} title={t('playlists.list.playlistEmpty')} description={t('playlists.list.playlistEmptyHint')} />
    );
  }

  const click = (index: number, id: string, shift: boolean) => {
    if (shift && lastClicked.current !== null) {
      const ids = idsInRange(lastClicked.current, index, (i) => entryAt(i)?.id);
      onSelect((current) => new Set([...current, ...ids]));
    } else {
      onSelect((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }
    lastClicked.current = index;
  };

  return (
    <div ref={scrollRef} className="scrollbar-thin h-full overflow-y-auto overscroll-contain" role="list" aria-label={t('playlists.list.label')}>
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const entry = entryAt(item.index);
          return (
            <div key={item.key} role="listitem" className="absolute left-0 top-0 w-full px-1" style={{ height: item.size, transform: `translateY(${item.start}px)` }}>
              {entry ? (
                <Row
                  entry={entry}
                  index={item.index}
                  groupName={entry.groupId ? groupNames.get(entry.groupId) : undefined}
                  showGroup={filter.scope.type === 'all'}
                  checked={selected.has(entry.id)}
                  dropping={dropIndex === item.index}
                  selected={selected}
                  onClick={click}
                  onEdit={onEdit}
                  onRemove={onRemove}
                  onDragOverRow={(index) => setDropIndex(index)}
                  onDragLeaveRow={() => setDropIndex(null)}
                  onDropOnRow={(ids) => {
                    setDropIndex(null);
                    onDropBefore(entry, ids);
                  }}
                />
              ) : (
                <div className="flex h-full items-center gap-3 px-3" aria-hidden>
                  <div className="h-4 w-4 rounded bg-fg/10" />
                  <div className="h-10 w-14 rounded-md bg-fg/5" />
                  <div className="h-3 w-48 animate-pulse rounded bg-fg/10" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RowProps {
  entry: PlaylistEntryDto;
  index: number;
  groupName: string | undefined;
  showGroup: boolean;
  checked: boolean;
  dropping: boolean;
  selected: ReadonlySet<string>;
  onClick: (index: number, id: string, shift: boolean) => void;
  onEdit: (entry: PlaylistEntryDto) => void;
  onRemove: (entry: PlaylistEntryDto) => void;
  onDragOverRow: (index: number) => void;
  onDragLeaveRow: () => void;
  onDropOnRow: (ids: string[]) => void;
}

function Row({ entry, index, groupName, showGroup, checked, dropping, selected, onClick, onEdit, onRemove, onDragOverRow, onDragLeaveRow, onDropOnRow }: RowProps) {
  const missing = entry.status === 'missing';
  return (
    <div
      draggable
      onDragStart={(event) => writeDrag(event, idsToDrag(entry.id, selected))}
      onDragOver={(event) => {
        if (!hasDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        onDragOverRow(index);
      }}
      onDragLeave={onDragLeaveRow}
      onDrop={(event) => {
        const ids = readDrag(event);
        if (!ids) return;
        event.preventDefault();
        if (ids.length === 1 && ids[0] === entry.id) return onDragLeaveRow();
        onDropOnRow(ids);
      }}
      onDoubleClick={() => onEdit(entry)}
      className={cn('flex h-full items-center gap-2 rounded-lg border-t-2 pr-1 transition-colors', dropping ? 'border-brand bg-brand/10' : 'border-transparent', checked ? 'bg-brand/10' : 'hover:bg-fg/5', missing && 'opacity-70')}
    >
      <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-fg-subtle/50" aria-hidden />
      <input
        type="checkbox"
        checked={checked}
        aria-label={t('playlists.selectNamed', { name: entry.name })}
        onChange={() => undefined}
        onClick={(event) => onClick(index, entry.id, event.shiftKey)}
        className="h-4 w-4 shrink-0 accent-brand"
      />
      <Img
        key={`${entry.sourceId}:${entry.sourceKey}`}
        sources={imageSources(entry.logo, catalogImageProxy(entry.sourceId, 'channel', entry.sourceKey))}
        fit="contain"
        className="flex h-10 w-14 shrink-0 items-center justify-center rounded-md bg-fg/5 ring-1 ring-inset ring-line/5"
        imgClassName="p-0.5"
        fallback={<Initials name={entry.name} />}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm text-fg">{entry.name}</span>
          {missing && <Badge tone="danger">{t('playlists.list.missing')}</Badge>}
        </span>
        <span className="block truncate text-xs text-fg-subtle">
          {[showGroup ? (groupName ?? t('playlists.noGroup')) : null, entry.sourceName, entry.status === 'unplayable' ? t('playlists.list.notPlayable') : null].filter(Boolean).join(' · ')}
        </span>
      </span>
      {entry.number !== null && <span className="shrink-0 rounded-md bg-fg/5 px-1.5 py-0.5 text-xs font-medium tabular-nums text-fg-muted">#{entry.number}</span>}
      <IconButton label={t('playlists.editNamed', { name: entry.name })} onClick={() => onEdit(entry)}>
        <Pencil className="h-4 w-4" />
      </IconButton>
      <IconButton label={t('playlists.removeNamed', { name: entry.name })} onClick={() => onRemove(entry)}>
        <Trash2 className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

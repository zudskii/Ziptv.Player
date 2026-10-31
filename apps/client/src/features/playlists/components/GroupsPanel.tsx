import type { PlaylistDto, PlaylistGroupDto } from '@ziptv/contracts';
import { Ellipsis, FolderPlus, Layers, ListX } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Popover } from '../../../components/ui/Popover';
import { cn } from '../../../lib/cn';
import { hasDrag, readDrag } from '../drag';
import type { EntryFilter } from '../entry-filter';

type Scope = EntryFilter['scope'];

interface GroupsPanelProps {
  playlist: PlaylistDto;
  scope: Scope;
  onScope: (scope: Scope) => void;
  /** Entries dropped on a group (null = "no group"): they go to its end. */
  onDropEntries: (groupId: string | null, ids: string[]) => void;
  onAddGroup: () => void;
  onRenameGroup: (group: PlaylistGroupDto) => void;
  onDeleteGroup: (group: PlaylistGroupDto) => void;
  onMoveGroup: (group: PlaylistGroupDto, direction: -1 | 1) => void;
}

const sameScope = (a: Scope, b: Scope): boolean => a.type === b.type && (a.type !== 'group' || (b.type === 'group' && a.groupId === b.groupId));

/** Groups of the playlist: pick one to show, drop entries on one to move them, manage them. */
export function GroupsPanel({ playlist, scope, onScope, onDropEntries, onAddGroup, onRenameGroup, onDeleteGroup, onMoveGroup }: GroupsPanelProps) {
  const [hover, setHover] = useState<string | null>(null);
  const groups = [...playlist.groups].sort((a, b) => a.position - b.position);

  const target = (key: string, groupId: string | null) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!hasDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setHover(key);
    },
    onDragLeave: () => setHover((current) => (current === key ? null : current)),
    onDrop: (event: React.DragEvent) => {
      setHover(null);
      const ids = readDrag(event);
      if (!ids) return;
      event.preventDefault();
      onDropEntries(groupId, ids);
    },
  });

  return (
    <nav aria-label="Groups" className="flex h-full flex-col gap-1 overflow-y-auto p-2">
      <Row active={sameScope(scope, { type: 'all' })} icon={<Layers className="h-4 w-4" />} label="All channels" count={playlist.entryCount} onClick={() => onScope({ type: 'all' })} />
      <Row
        active={sameScope(scope, { type: 'ungrouped' })}
        icon={<ListX className="h-4 w-4" />}
        label="No group"
        count={playlist.ungroupedCount}
        highlighted={hover === 'ungrouped'}
        onClick={() => onScope({ type: 'ungrouped' })}
        {...target('ungrouped', null)}
      />

      <div className="my-1 border-t border-line/5" />

      {groups.map((group, index) => (
        <Row
          key={group.id}
          active={sameScope(scope, { type: 'group', groupId: group.id })}
          label={group.name}
          count={group.entryCount}
          highlighted={hover === group.id}
          onClick={() => onScope({ type: 'group', groupId: group.id })}
          menu={
            <GroupMenu
              group={group}
              isFirst={index === 0}
              isLast={index === groups.length - 1}
              onRename={() => onRenameGroup(group)}
              onDelete={() => onDeleteGroup(group)}
              onMove={(direction) => onMoveGroup(group, direction)}
            />
          }
          {...target(group.id, group.id)}
        />
      ))}

      <button type="button" onClick={onAddGroup} className="mt-1 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-brand-soft hover:bg-brand/10">
        <FolderPlus className="h-4 w-4" /> New group
      </button>
    </nav>
  );
}

interface RowProps {
  active: boolean;
  label: string;
  count: number;
  icon?: ReactNode;
  menu?: ReactNode;
  highlighted?: boolean;
  onClick: () => void;
  onDragOver?: (event: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (event: React.DragEvent) => void;
}

function Row({ active, label, count, icon, menu, highlighted, onClick, onDragOver, onDragLeave, onDrop }: RowProps) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn('group flex items-center rounded-lg transition-colors', active ? 'bg-brand/15' : 'hover:bg-fg/5', highlighted && 'bg-brand/25 ring-2 ring-inset ring-brand')}
    >
      <button type="button" onClick={onClick} aria-current={active ? 'true' : undefined} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand">
        {icon && <span className={active ? 'text-brand-soft' : 'text-fg-subtle'}>{icon}</span>}
        <span className={cn('min-w-0 flex-1 truncate', active ? 'font-medium text-fg' : 'text-fg-muted')}>{label}</span>
        <span className="shrink-0 text-xs tabular-nums text-fg-subtle">{count.toLocaleString()}</span>
      </button>
      {menu}
    </div>
  );
}

function GroupMenu({ group, isFirst, isLast, onRename, onDelete, onMove }: { group: PlaylistGroupDto; isFirst: boolean; isLast: boolean; onRename: () => void; onDelete: () => void; onMove: (direction: -1 | 1) => void }) {
  const item = 'flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-fg-muted hover:bg-fg/5 hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <Popover
      align="right"
      className="w-44 p-1"
      trigger={({ toggle, open }) => (
        <button type="button" onClick={toggle} aria-label={`Options for ${group.name}`} aria-haspopup="menu" aria-expanded={open} className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-fg/10 hover:text-fg">
          <Ellipsis className="h-4 w-4" />
        </button>
      )}
    >
      {(close) => (
        <div role="menu">
          <button type="button" role="menuitem" className={item} onClick={() => { close(); onRename(); }}>
            Rename
          </button>
          <button type="button" role="menuitem" className={item} disabled={isFirst} onClick={() => { close(); onMove(-1); }}>
            Move up
          </button>
          <button type="button" role="menuitem" className={item} disabled={isLast} onClick={() => { close(); onMove(1); }}>
            Move down
          </button>
          <button type="button" role="menuitem" className={cn(item, 'text-red-500 hover:text-red-500')} onClick={() => { close(); onDelete(); }}>
            Delete group…
          </button>
        </div>
      )}
    </Popover>
  );
}

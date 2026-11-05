import type { PlaylistEntryDto, PlaylistGroupDto } from '@ziptv/contracts';
import { ArrowLeft, Ellipsis, FolderInput, Hash, Link2, ListPlus, Merge, Pencil, Send, Trash2, TriangleAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { FullscreenMessage } from '../../components/ui/FullscreenMessage';
import { Popover } from '../../components/ui/Popover';
import { PromptDialog } from '../../components/ui/PromptDialog';
import { Spinner } from '../../components/ui/Spinner';
import { ApiError, errorMessage } from '../../lib/api-client';
import { useDebounced } from '../../lib/use-debounced';
import {
  fetchEntryIds,
  useCreateGroup,
  useDeleteGroup,
  useDeletePlaylist,
  useMoveEntries,
  usePlaylist,
  useRelink,
  useRemoveEntries,
  useRenamePlaylist,
  useRenameGroup,
  useReorderGroups,
} from '../../features/playlists/api';
import { AddChannelsDialog } from '../../features/playlists/components/AddChannelsDialog';
import { EditEntryDialog } from '../../features/playlists/components/EditEntryDialog';
import { EntryList } from '../../features/playlists/components/EntryList';
import { ExportDialog } from '../../features/playlists/components/ExportDialog';
import { GroupsPanel } from '../../features/playlists/components/GroupsPanel';
import { MergeDialog } from '../../features/playlists/components/MergeDialog';
import { MoveToDialog } from '../../features/playlists/components/MoveToDialog';
import { RenumberDialog } from '../../features/playlists/components/RenumberDialog';
import { TransferDialog } from '../../features/playlists/components/TransferDialog';
import { ALL_ENTRIES, filterKey, type EntryFilter } from '../../features/playlists/entry-filter';
import { moveItem } from '../../features/playlists/reorder';
import { t } from '../../i18n';
import { Tooltip } from '../../components/ui/Tooltip';

type Dialog =
  | { type: 'add' | 'export' | 'renumber' | 'merge' | 'rename' | 'newGroup' | 'move' | 'transfer' | 'removeSelected' | 'deletePlaylist' | 'removeMissing' }
  | { type: 'edit'; entry: PlaylistEntryDto }
  | { type: 'removeEntry'; entry: PlaylistEntryDto }
  | { type: 'renameGroup' | 'deleteGroup'; group: PlaylistGroupDto };

const scopeValue = (scope: EntryFilter['scope']): string => (scope.type === 'group' ? scope.groupId : scope.type);
const WHOLE_PLAYLIST: EntryFilter['scope'] = { type: 'all' };
const NOTHING_SELECTED: ReadonlySet<string> = new Set();

/** Build one playlist: add channels, group, rename, number, move, merge, and get its link. */
export function PlaylistEditorPage() {
  const { playlistId = '' } = useParams();
  const navigate = useNavigate();
  const query = usePlaylist(playlistId);
  const playlist = query.data;

  const [pickedScope, setScope] = useState<EntryFilter['scope']>(WHOLE_PLAYLIST);
  const [search, setSearch] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: '', ids: NOTHING_SELECTED });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [deleteGroupEntries, setDeleteGroupEntries] = useState(false);

  // A group that was deleted (here or elsewhere) must not leave an empty, unexplained list: fall back to everything.
  const scope = useMemo(
    () => (pickedScope.type === 'group' && playlist && !playlist.groups.some((group) => group.id === pickedScope.groupId) ? WHOLE_PLAYLIST : pickedScope),
    [pickedScope, playlist],
  );

  const debouncedSearch = useDebounced(search);
  const filter = useMemo<EntryFilter>(() => ({ ...ALL_ENTRIES, scope, search: debouncedSearch, missingOnly }), [scope, debouncedSearch, missingOnly]);
  const key = filterKey(filter);

  // What was ticked in another view is not ticked in this one: the selection belongs to the view it was made in.
  const selected = selection.key === key ? selection.ids : NOTHING_SELECTED;
  const setSelected = (next: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>)) =>
    setSelection((current) => {
      const base = current.key === key ? current.ids : NOTHING_SELECTED;
      return { key, ids: typeof next === 'function' ? next(base) : next };
    });

  const renamePlaylist = useRenamePlaylist(playlistId);
  const deletePlaylist = useDeletePlaylist();
  const createGroup = useCreateGroup(playlistId);
  const renameGroup = useRenameGroup(playlistId);
  const deleteGroup = useDeleteGroup(playlistId);
  const reorderGroups = useReorderGroups(playlistId);
  const move = useMoveEntries(playlistId);
  const removeEntries = useRemoveEntries(playlistId);
  const relink = useRelink(playlistId);

  const groupNames = useMemo(() => new Map((playlist?.groups ?? []).map((group) => [group.id, group.name] as const)), [playlist?.groups]);

  if (query.isPending) return <Spinner className="py-24" label={t('playlists.editor.loading')} />;
  if (query.isError || !playlist) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <FullscreenMessage
        tone="error"
        title={notFound ? t('playlists.editor.notFound') : t('playlists.editor.loadFailed')}
        description={notFound ? t('playlists.editor.maybeDeleted') : errorMessage(query.error)}
        action={notFound ? { label: t('playlists.editor.all'), onClick: () => navigate('/playlists') } : { label: t('playlists.retry'), onClick: () => void query.refetch() }}
      />
    );
  }

  const groups = [...playlist.groups].sort((a, b) => a.position - b.position);
  const close = () => setDialog(null);
  const fail = (reason: unknown) => toast.error(errorMessage(reason));
  const movedToast = (result: { moved: number }) => toast.success(`${result.moved.toLocaleString()} ${result.moved === 1 ? 'channel' : 'channels'} moved`);

  const selectAll = async () => {
    try {
      const { ids, truncated, total } = await fetchEntryIds(playlistId, filter);
      setSelected(new Set(ids));
      if (truncated) toast.info(t('playlists.toast.selectedFirst', { count: ids.length, total }), { description: t('playlists.narrow') });
    } catch (reason) {
      fail(reason);
    }
  };

  const removeMissing = async () => {
    const { ids } = await fetchEntryIds(playlistId, { ...ALL_ENTRIES, missingOnly: true }, 50_000);
    const result = await removeEntries.mutateAsync(ids);
    setMissingOnly(false);
    toast.success(t('playlists.toast.missingRemoved', { count: result.removed }));
  };

  const selectedIds = [...selected];

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] flex-col lg:h-[calc(100dvh-3.5rem)]">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3 border-b border-line/5 px-4 py-3 sm:px-5">
        <Link to="/playlists" aria-label={t('playlists.editor.all')} className="flex h-9 w-9 items-center justify-center rounded-lg text-fg-muted hover:bg-fg/10 hover:text-fg">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2">
            <span className="truncate text-xl font-bold text-fg">{playlist.name}</span>
            <Tooltip content={t('playlists.editor.rename')} redundant>
              <button type="button" aria-label={t('playlists.editor.rename')} onClick={() => setDialog({ type: 'rename' })} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-fg/10 hover:text-fg">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </h1>
          <p className="text-xs text-fg-muted">
            {t('playlists.count.channelsGroups', { channels: playlist.entryCount, groups: playlist.groups.length })}
          </p>
        </div>
        <Button variant="primary" icon={<ListPlus className="h-4 w-4" />} onClick={() => setDialog({ type: 'add' })}>
          {t('playlists.add.title')}
        </Button>
        <Button icon={<Link2 className="h-4 w-4" />} onClick={() => setDialog({ type: 'export' })}>
          {t('playlists.editor.link')}
          {playlist.export.enabled && <span className="h-2 w-2 rounded-full bg-emerald-500" aria-label={t('playlists.editor.on')} />}
        </Button>
        <Popover
          className="w-56 p-1"
          trigger={({ toggle, open }) => (
            <Button aria-label={t('playlists.editor.more')} aria-haspopup="menu" aria-expanded={open} onClick={toggle} className="px-2.5">
              <Ellipsis className="h-4 w-4" />
            </Button>
          )}
        >
          {(closeMenu) => {
            const item = 'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-fg-muted hover:bg-fg/5 hover:text-fg';
            const open = (next: Dialog) => () => {
              closeMenu();
              setDialog(next);
            };
            return (
              <div role="menu">
                <button type="button" role="menuitem" className={item} onClick={open({ type: 'renumber' })}>
                  <Hash className="h-4 w-4" /> {t('playlists.editor.number')}
                </button>
                <button type="button" role="menuitem" className={item} onClick={open({ type: 'merge' })}>
                  <Merge className="h-4 w-4" /> {t('playlists.editor.merge')}
                </button>
                <div className="my-1 border-t border-line/5" />
                <button type="button" role="menuitem" className={`${item} text-red-500 hover:text-red-500`} onClick={open({ type: 'deletePlaylist' })}>
                  <Trash2 className="h-4 w-4" /> {t('playlists.editor.delete')}
                </button>
              </div>
            );
          }}
        </Popover>
      </header>

      {/* Channels that disappeared from their source */}
      {playlist.missingCount > 0 && (
        <div role="status" className="flex flex-wrap items-center gap-3 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-sm sm:px-5">
          <TriangleAlert className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
          <p className="min-w-0 flex-1 text-fg">
            {t('playlists.missingBanner', { count: playlist.missingCount })}
          </p>
          <Button
            size="sm"
            loading={relink.isPending}
            onClick={() =>
              relink.mutate(undefined, {
                onSuccess: (result) => toast[result.relinked > 0 ? 'success' : 'info'](result.relinked > 0 ? t('playlists.toast.reconnected', { count: result.relinked }) : t('playlists.nothingReconnected'), { description: result.stillMissing > 0 ? t('playlists.toast.stillMissing', { count: result.stillMissing }) : undefined }),
                onError: fail,
              })
            }
          >
            {t('playlists.editor.reconnect')}
          </Button>
          <Button size="sm" onClick={() => setMissingOnly((value) => !value)}>
            {missingOnly ? t('playlists.editor.showAll') : t('playlists.editor.showThem')}
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDialog({ type: 'removeMissing' })}>
            {t('playlists.remove')}
          </Button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="hidden min-h-0 border-r border-line/5 lg:block">
          <GroupsPanel
            playlist={playlist}
            scope={scope}
            onScope={setScope}
            onDropEntries={(groupId, ids) => move.mutate({ entryIds: ids, groupId }, { onSuccess: movedToast, onError: fail })}
            onAddGroup={() => setDialog({ type: 'newGroup' })}
            onRenameGroup={(group) => setDialog({ type: 'renameGroup', group })}
            onDeleteGroup={(group) => {
              setDeleteGroupEntries(false);
              setDialog({ type: 'deleteGroup', group });
            }}
            onMoveGroup={(group, direction) =>
              reorderGroups.mutate(moveItem(groups.map((item) => item.id), group.id, direction), { onError: fail })
            }
          />
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          {/* Toolbar */}
          <div className="space-y-2 border-b border-line/5 px-3 py-2.5 sm:px-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={t('playlists.editor.selectAll')}
                checked={selected.size > 0}
                onChange={() => (selected.size > 0 ? setSelected(new Set()) : void selectAll())}
                className="h-4 w-4 shrink-0 accent-brand"
              />
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('playlists.editor.search')} aria-label={t('playlists.editor.search')} className="field h-9" />
              <select
                aria-label={t('playlists.editor.group')}
                value={scopeValue(scope)}
                onChange={(event) => {
                  const value = event.target.value;
                  setScope(value === 'all' || value === 'ungrouped' ? { type: value } : { type: 'group', groupId: value });
                }}
                className="field h-9 w-40 lg:hidden"
              >
                <option value="all">{t('playlists.allChannels')}</option>
                <option value="ungrouped">{t('playlists.noGroup')}</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
              {missingOnly && <Badge tone="warning">{t('playlists.editor.missingOnly')}</Badge>}
            </div>

            {selected.size > 0 && (
              <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={t('playlists.editor.selected')}>
                <span className="text-sm font-medium text-fg">{t('playlists.count.selected', { count: selected.size })}</span>
                <Button size="sm" icon={<FolderInput className="h-4 w-4" />} onClick={() => setDialog({ type: 'move' })}>
                  {t('playlists.editor.moveTo')}
                </Button>
                <Button size="sm" icon={<Send className="h-4 w-4" />} onClick={() => setDialog({ type: 'transfer' })}>
                  {t('playlists.editor.sendTo')}
                </Button>
                <Button size="sm" variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setDialog({ type: 'removeSelected' })}>
                  {t('playlists.remove')}
                </Button>
                <Button size="sm" variant="ghost" icon={<X className="h-4 w-4" />} onClick={() => setSelected(new Set())}>
                  {t('playlists.clear')}
                </Button>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1">
            <EntryList
              playlistId={playlistId}
              filter={filter}
              groupNames={groupNames}
              selected={selected}
              onSelect={setSelected}
              onEdit={(entry) => setDialog({ type: 'edit', entry })}
              onRemove={(entry) => setDialog({ type: 'removeEntry', entry })}
              onDropBefore={(target, ids) => move.mutate({ entryIds: ids, groupId: target.groupId, beforeEntryId: target.id }, { onSuccess: movedToast, onError: fail })}
            />
          </div>
        </section>
      </div>

      {/* Dialogs */}
      <AddChannelsDialog open={dialog?.type === 'add'} onClose={close} playlist={playlist} />
      <ExportDialog open={dialog?.type === 'export'} onClose={close} playlist={playlist} />
      <RenumberDialog open={dialog?.type === 'renumber'} onClose={close} playlistId={playlistId} entryCount={playlist.entryCount} />
      <MergeDialog open={dialog?.type === 'merge'} onClose={close} playlistId={playlistId} />
      <MoveToDialog open={dialog?.type === 'move'} onClose={close} playlistId={playlistId} groups={groups} entryIds={selectedIds} onMoved={() => setSelected(new Set())} />
      <TransferDialog open={dialog?.type === 'transfer'} onClose={close} playlistId={playlistId} entryIds={selectedIds} onDone={() => setSelected(new Set())} />
      <EditEntryDialog entry={dialog?.type === 'edit' ? dialog.entry : null} playlistId={playlistId} onClose={close} />

      <PromptDialog open={dialog?.type === 'rename'} onClose={close} title={t('playlists.editor.rename')} label={t('playlists.name')} initialValue={playlist.name} submitLabel={t('playlists.rename')} onSubmit={(name) => renamePlaylist.mutateAsync(name)} />
      <PromptDialog open={dialog?.type === 'newGroup'} onClose={close} title={t('playlists.group.new')} label={t('playlists.group.name')} placeholder={t('playlists.group.placeholder')} submitLabel={t('playlists.create')} onSubmit={(name) => createGroup.mutateAsync(name)} />
      <PromptDialog
        open={dialog?.type === 'renameGroup'}
        onClose={close}
        title={t('playlists.group.rename')}
        label={t('playlists.group.name')}
        initialValue={dialog?.type === 'renameGroup' ? dialog.group.name : ''}
        submitLabel={t('playlists.rename')}
        onSubmit={(name) => (dialog?.type === 'renameGroup' ? renameGroup.mutateAsync({ groupId: dialog.group.id, name }) : undefined)}
      />

      <ConfirmDialog
        open={dialog?.type === 'deleteGroup'}
        onClose={close}
        title={t('playlists.deleteGroupTitle', { name: dialog?.type === 'deleteGroup' ? dialog.group.name : '' })}
        description={
          <div className="space-y-3">
            <p>{t('playlists.group.deleteHint')}</p>
            <label className="flex items-center gap-2 text-fg">
              <input type="checkbox" checked={deleteGroupEntries} onChange={(event) => setDeleteGroupEntries(event.target.checked)} className="h-4 w-4 accent-brand" />
              {t('playlists.alsoDelete', { count: dialog?.type === 'deleteGroup' ? dialog.group.entryCount : 0 })}
            </label>
          </div>
        }
        confirmLabel={t('playlists.group.delete')}
        onConfirm={() => (dialog?.type === 'deleteGroup' ? deleteGroup.mutateAsync({ groupId: dialog.group.id, deleteEntries: deleteGroupEntries }) : undefined)}
      />
      <ConfirmDialog
        open={dialog?.type === 'removeSelected'}
        onClose={close}
        title={t('playlists.removeSelectedTitle', { count: selected.size })}
        description={t('playlists.editor.removeHint')}
        confirmLabel={t('playlists.remove')}
        onConfirm={async () => {
          await removeEntries.mutateAsync(selectedIds);
          setSelected(new Set());
        }}
      />
      <ConfirmDialog
        open={dialog?.type === 'removeEntry'}
        onClose={close}
        title={t('playlists.removeEntryTitle', { name: dialog?.type === 'removeEntry' ? dialog.entry.name : '' })}
        description={t('playlists.editor.removeOneHint')}
        confirmLabel={t('playlists.remove')}
        onConfirm={() => (dialog?.type === 'removeEntry' ? removeEntries.mutateAsync([dialog.entry.id]) : undefined)}
      />
      <ConfirmDialog
        open={dialog?.type === 'removeMissing'}
        onClose={close}
        title={t('playlists.removeMissingTitle', { count: playlist.missingCount })}
        description={t('playlists.editor.missingHint')}
        confirmLabel={t('playlists.editor.removeThem')}
        onConfirm={removeMissing}
      />
      <ConfirmDialog
        open={dialog?.type === 'deletePlaylist'}
        onClose={close}
        title={t('playlists.deleteTitle', { name: playlist.name })}
        description={t('playlists.editor.deleteHint')}
        confirmLabel={t('playlists.delete')}
        onConfirm={async () => {
          await deletePlaylist.mutateAsync(playlistId);
          toast.success(`“${playlist.name}” deleted`);
          navigate('/playlists', { replace: true });
        }}
      />
    </div>
  );
}


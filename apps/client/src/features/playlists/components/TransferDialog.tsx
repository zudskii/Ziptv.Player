import type { TransferEntriesRequest } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Segmented } from '../../../components/ui/Segmented';
import { errorMessage } from '../../../lib/api-client';
import { playlistKeys, useCreateGroup, usePlaylists, useTransferEntries } from '../api';
import { playlistsApi } from '../client';
import { isChoiceReady, NO_GROUP, type GroupChoice } from '../group-choice';
import { GroupPicker } from './GroupPicker';

interface TransferDialogProps {
  open: boolean;
  onClose: () => void;
  playlistId: string;
  entryIds: string[];
  onDone: () => void;
}

type Placement = 'keep' | 'group';

/** Copy or move channels into another playlist of yours. */
export function TransferDialog({ open, onClose, ...rest }: TransferDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={`Send ${rest.entryIds.length.toLocaleString()} ${rest.entryIds.length === 1 ? 'channel' : 'channels'} to another playlist`}>
      {open && <TransferForm onClose={onClose} {...rest} />}
    </Dialog>
  );
}

function TransferForm({ onClose, playlistId, entryIds, onDone }: Omit<TransferDialogProps, 'open'>) {
  const playlists = usePlaylists();
  const transfer = useTransferEntries(playlistId);
  const [targetId, setTargetId] = useState('');
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [placement, setPlacement] = useState<Placement>('keep');
  const [choice, setChoice] = useState<GroupChoice>(NO_GROUP);
  const [error, setError] = useState<string | null>(null);
  const others = (playlists.data ?? []).filter((playlist) => playlist.id !== playlistId);

  const target = useQuery({ queryKey: playlistKeys.one(targetId), queryFn: ({ signal }) => playlistsApi.get(targetId, signal), enabled: Boolean(targetId) && placement === 'group' });
  const createGroup = useCreateGroup(targetId);
  const pending = transfer.isPending || createGroup.isPending;

  if (playlists.isPending) return <p className="py-6 text-center text-sm text-fg-muted">Loading…</p>;
  if (others.length === 0) return <p className="py-6 text-center text-sm text-fg-muted">Create another playlist first.</p>;

  const ready = Boolean(targetId) && (placement === 'keep' || (target.data !== undefined && isChoiceReady(choice)));

  const submit = async () => {
    setError(null);
    try {
      let request: TransferEntriesRequest = { entryIds, toPlaylistId: targetId, mode };
      if (placement === 'group') {
        const groupId = choice.type === 'none' ? null : choice.type === 'group' ? choice.groupId : (await createGroup.mutateAsync(choice.name.trim())).id;
        request = { ...request, group: { groupId } };
      }
      const result = await transfer.mutateAsync(request);
      toast.success(`${result.transferred.toLocaleString()} ${mode === 'copy' ? 'copied' : 'moved'}`, { description: result.skipped > 0 ? `${result.skipped.toLocaleString()} already there.` : undefined });
      onDone();
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="space-y-4">
      <Segmented label="What to do" value={mode} onChange={setMode} options={[{ value: 'copy', label: 'Copy' }, { value: 'move', label: 'Move' }]} />

      <div className="space-y-1.5">
        <label htmlFor="transfer-target" className="text-sm text-fg-muted">
          Playlist
        </label>
        <select id="transfer-target" value={targetId} onChange={(event) => { setTargetId(event.target.value); setChoice(NO_GROUP); }} className="field">
          <option value="">Choose…</option>
          {others.map((playlist) => (
            <option key={playlist.id} value={playlist.id}>
              {playlist.name} ({playlist.entryCount.toLocaleString()})
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <p className="text-sm text-fg-muted">Groups</p>
        <Segmented label="Groups" size="sm" value={placement} onChange={setPlacement} options={[{ value: 'keep', label: 'Keep group names' }, { value: 'group', label: 'Choose a group' }]} />
        {placement === 'group' && targetId && (target.isPending ? <p className="text-sm text-fg-muted">Loading groups…</p> : <GroupPicker groups={target.data?.groups ?? []} value={choice} onChange={setChoice} />)}
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button variant="primary" loading={pending} disabled={!ready} onClick={submit}>
          {mode === 'copy' ? 'Copy' : 'Move'}
        </Button>
      </div>
    </div>
  );
}


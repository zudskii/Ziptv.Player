import type { PlaylistGroupDto } from '@ziptv/contracts';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { errorMessage } from '../../../lib/api-client';
import { useCreateGroup, useMoveEntries } from '../api';
import { isChoiceReady, NO_GROUP, type GroupChoice } from '../group-choice';
import { GroupPicker } from './GroupPicker';

interface MoveToDialogProps {
  open: boolean;
  onClose: () => void;
  playlistId: string;
  groups: readonly PlaylistGroupDto[];
  entryIds: string[];
  onMoved: () => void;
}

/** "Move to…": the touch- and keyboard-friendly way to regroup, next to drag and drop. */
export function MoveToDialog({ open, onClose, ...rest }: MoveToDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={`Move ${rest.entryIds.length.toLocaleString()} ${rest.entryIds.length === 1 ? 'channel' : 'channels'} to…`} description="They go to the end of the group, in the order they have now.">
      {open && <MoveForm onClose={onClose} {...rest} />}
    </Dialog>
  );
}

function MoveForm({ onClose, playlistId, groups, entryIds, onMoved }: Omit<MoveToDialogProps, 'open'>) {
  const createGroup = useCreateGroup(playlistId);
  const move = useMoveEntries(playlistId);
  const [choice, setChoice] = useState<GroupChoice>(NO_GROUP);
  const [error, setError] = useState<string | null>(null);
  const pending = createGroup.isPending || move.isPending;

  const submit = async () => {
    setError(null);
    try {
      const groupId = choice.type === 'none' ? null : choice.type === 'group' ? choice.groupId : (await createGroup.mutateAsync(choice.name.trim())).id;
      const result = await move.mutateAsync({ entryIds, groupId });
      toast.success(`${result.moved.toLocaleString()} ${result.moved === 1 ? 'channel' : 'channels'} moved`);
      onMoved();
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="space-y-4">
      <GroupPicker groups={groups} value={choice} onChange={setChoice} />
      {error && (
        <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button variant="primary" loading={pending} disabled={!isChoiceReady(choice)} onClick={submit}>
          Move
        </Button>
      </div>
    </div>
  );
}

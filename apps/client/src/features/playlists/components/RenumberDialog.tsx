import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { errorMessage } from '../../../lib/api-client';
import { useRenumber } from '../api';
import { numberingProblem } from '../numbering';

interface RenumberDialogProps {
  open: boolean;
  onClose: () => void;
  playlistId: string;
  entryCount: number;
}

/** Numbers every channel in the order of the playlist (these become `tvg-chno` in the exported file). */
export function RenumberDialog({ open, onClose, ...rest }: RenumberDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Number the channels" description="Channels are numbered in the order shown: ungrouped first, then each group in turn." className="w-[min(94vw,26rem)]">
      {open && <RenumberForm onClose={onClose} {...rest} />}
    </Dialog>
  );
}

function RenumberForm({ onClose, playlistId, entryCount }: Omit<RenumberDialogProps, 'open'>) {
  const renumber = useRenumber(playlistId);
  const ids = { start: useId(), step: useId() };
  const [start, setStart] = useState('1');
  const [step, setStep] = useState('1');
  const startValue = Number(start);
  const stepValue = Number(step);
  const problem = numberingProblem(startValue, stepValue, entryCount);
  const last = startValue + Math.max(0, entryCount - 1) * stepValue;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem) return;
    try {
      const result = await renumber.mutateAsync({ start: startValue, step: stepValue });
      toast.success(`${result.renumbered.toLocaleString()} channels numbered`);
      onClose();
    } catch (reason) {
      toast.error(errorMessage(reason));
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label htmlFor={ids.start} className="text-sm text-fg-muted">
            Start at
          </label>
          <input id={ids.start} type="number" inputMode="numeric" min={1} max={99999} value={start} onChange={(e) => setStart(e.target.value)} className="field" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={ids.step} className="text-sm text-fg-muted">
            Step
          </label>
          <input id={ids.step} type="number" inputMode="numeric" min={1} max={1000} value={step} onChange={(e) => setStep(e.target.value)} className="field" />
        </div>
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-red-500">
          {problem}
        </p>
      ) : (
        <p className="text-sm text-fg-muted">
          {entryCount.toLocaleString()} channels get the numbers {startValue.toLocaleString()} to {last.toLocaleString()}. Numbers you set by hand are replaced.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={renumber.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={renumber.isPending} disabled={Boolean(problem) || entryCount === 0}>
          Number channels
        </Button>
      </div>
    </form>
  );
}

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { errorMessage } from '../../../lib/api-client';
import { useRenumber } from '../api';
import { numberingProblem } from '../numbering';
import { t } from '../../../i18n';

interface RenumberDialogProps {
  open: boolean;
  onClose: () => void;
  playlistId: string;
  entryCount: number;
}

/** Numbers every channel in the order of the playlist (these become `tvg-chno` in the exported file). */
export function RenumberDialog({ open, onClose, ...rest }: RenumberDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={t('playlists.renumber.title')} description={t('playlists.renumber.hint')} className="w-[min(94vw,26rem)]">
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
      toast.success(t('playlists.toast.numbered', { count: result.renumbered }));
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
            {t('playlists.renumber.start')}
          </label>
          <input id={ids.start} type="number" inputMode="numeric" min={1} max={99999} value={start} onChange={(e) => setStart(e.target.value)} className="field" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={ids.step} className="text-sm text-fg-muted">
            {t('playlists.renumber.step')}
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
          {t('playlists.renumberPreview', { count: entryCount, start: startValue, last })}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={renumber.isPending}>
          {t('playlists.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={renumber.isPending} disabled={Boolean(problem) || entryCount === 0}>
          {t('playlists.renumber.do')}
        </Button>
      </div>
    </form>
  );
}

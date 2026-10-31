import { useId, useState, type FormEvent } from 'react';

import { errorMessage } from '../../lib/api-client';
import { Button } from './Button';
import { Dialog } from './Dialog';

interface PromptDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  label: string;
  submitLabel: string;
  initialValue?: string;
  placeholder?: string;
  maxLength?: number;
  /** Throw to show the message under the field (e.g. the server's "group already exists"). */
  onSubmit: (value: string) => Promise<unknown> | unknown;
}

/** One text field in a dialog: names of playlists and groups. Remounts its form each time it opens. */
export function PromptDialog({ open, onClose, ...rest }: PromptDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={rest.title} className="w-[min(94vw,26rem)]">
      {open && <PromptForm onClose={onClose} {...rest} />}
    </Dialog>
  );
}

function PromptForm({ onClose, label, submitLabel, initialValue = '', placeholder, maxLength = 120, onSubmit }: Omit<PromptDialogProps, 'open' | 'title'>) {
  const id = useId();
  const [value, setValue] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor={id} className="text-sm text-fg-muted">
          {label}
        </label>
        <input id={id} autoFocus value={value} maxLength={maxLength} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} className="field" />
        {error && (
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={pending} disabled={!trimmed || trimmed === initialValue.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

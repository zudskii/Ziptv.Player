import { useState, type ReactNode } from 'react';

import { errorMessage } from '../../lib/api-client';
import { Button } from './Button';
import { Dialog } from './Dialog';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  /** `danger` for anything that deletes. */
  tone?: 'primary' | 'danger';
  onConfirm: () => Promise<unknown> | unknown;
}

/** "Are you sure?" with a pending state and the server's reason when it fails. */
export function ConfirmDialog({ open, onClose, title, description, confirmLabel, tone = 'danger', onConfirm }: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (pending) return;
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title={title} className="w-[min(94vw,28rem)]">
      <div className="space-y-4">
        {description && <div className="text-sm text-fg-muted">{description}</div>}
        {error && (
          <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-500">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await onConfirm();
                setPending(false);
                onClose();
              } catch (reason) {
                setPending(false);
                setError(errorMessage(reason));
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

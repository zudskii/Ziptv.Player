import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { IconButton } from './Button';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Native <dialog>: focus trap, Esc-to-close, inert background and top-layer stacking
 * come from the browser instead of hand-rolled JS.
 */
export function Dialog({ open, onClose, title, description, children, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Click on the backdrop (the dialog element itself, outside the panel) closes it.
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'w-[min(92vw,34rem)] rounded-2xl border border-white/10 bg-ink-850 p-0 text-slate-100 shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm',
        className,
      )}
      aria-labelledby="dialog-title"
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-white/5 px-5 py-4">
            <div>
              <h2 id="dialog-title" className="text-base font-semibold text-white">
                {title}
              </h2>
              {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
            </div>
            <IconButton label="Close" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
        </div>
      )}
    </dialog>
  );
}

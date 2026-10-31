import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

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
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // React runs these handlers for events of *nested* dialogs too (it bubbles them through the
      // component tree although the browser does not). Without the target check, closing a
      // confirmation inside a dialog would close the outer dialog as well.
      onClose={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Click on the backdrop (the dialog element itself, outside the panel) closes it.
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'w-[min(94vw,34rem)] rounded-2xl border border-line/10 bg-elevated p-0 text-fg shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm',
        className,
      )}
      aria-labelledby={titleId}
    >
      {open && (
        <div className="flex max-h-[88vh] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-line/5 px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold text-fg">
                {title}
              </h2>
              {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
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

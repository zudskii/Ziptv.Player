import { useId, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { HelpHint } from './HelpHint';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  /** A longer explanation behind a "?" next to the label. */
  help?: ReactNode;
  disabled?: boolean;
}

/** Labelled on/off setting row. */
export function Switch({ checked, onChange, label, description, help, disabled }: SwitchProps) {
  const id = useId();
  return (
    // Not one big <label>: the "?" button inside it would become the labelled control.
    <div className={cn('flex items-center justify-between gap-4 py-2', disabled && 'opacity-50')}>
      <span className="min-w-0">
        <span className="flex items-center gap-1">
          <label htmlFor={id} className="text-sm text-fg">
            {label}
          </label>
          {help && <HelpHint topic={label}>{help}</HelpHint>}
        </span>
        {description && (
          <label htmlFor={id} className="mt-0.5 block text-xs text-fg-muted">
            {description}
          </label>
        )}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-brand' : 'bg-fg/20')}
      >
        <span className={cn('absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[22px]' : 'translate-x-0.5')} />
      </button>
    </div>
  );
}

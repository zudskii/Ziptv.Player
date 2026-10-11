import { cn } from '../../lib/cn';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}

/** Labelled on/off setting row. */
export function Switch({ checked, onChange, label, description, disabled }: SwitchProps) {
  return (
    <label className={cn('flex items-center justify-between gap-4 py-2', disabled && 'opacity-50')}>
      <span className="min-w-0">
        <span className="block text-sm text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-fg-muted">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-brand' : 'bg-fg/20')}
      >
        <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[22px]' : 'translate-x-0.5')} />
      </button>
    </label>
  );
}

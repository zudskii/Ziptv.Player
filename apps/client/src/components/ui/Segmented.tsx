import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

interface SegmentedProps<T extends string> {
  value: T;
  options: { value: T; label: ReactNode; icon?: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
  size?: 'sm' | 'md';
}

/** Tab-like single choice (M3U URL / File / Xtream, Dark / Light / System…). */
export function Segmented<T extends string>({ value, options, onChange, label, className, size = 'md' }: SegmentedProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('grid gap-1 rounded-lg bg-sunken/60 p-1', className)} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'flex items-center justify-center gap-2 rounded-md font-medium transition-colors',
            size === 'sm' ? 'h-8 px-2 text-xs' : 'h-9 px-3 text-sm',
            value === option.value ? 'bg-surface text-fg shadow-sm ring-1 ring-line/10' : 'text-fg-muted hover:text-fg',
          )}
        >
          {option.icon}
          <span className="truncate">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

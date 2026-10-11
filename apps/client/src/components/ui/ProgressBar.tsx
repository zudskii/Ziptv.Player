import { cn } from '../../lib/cn';

/** Thin progress bar (programme progress, watch progress). `value` in 0..1. */
export function ProgressBar({ value, className, tone = 'brand', label }: { value: number; className?: string; tone?: 'brand' | 'live' | 'muted'; label?: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={label}
      className={cn('h-1 w-full overflow-hidden rounded-full bg-fg/10', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', tone === 'live' ? 'bg-live' : tone === 'muted' ? 'bg-fg-subtle' : 'bg-brand')}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

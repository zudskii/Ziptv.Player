import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'live';

const TONES: Record<Tone, string> = {
  neutral: 'bg-fg/5 text-fg-muted ring-line/10',
  brand: 'bg-brand/10 text-brand-soft ring-brand/20',
  success: 'bg-emerald-500/10 text-emerald-500 ring-emerald-500/20',
  warning: 'bg-amber-500/10 text-amber-500 ring-amber-500/25',
  danger: 'bg-red-500/10 text-red-500 ring-red-500/25',
  live: 'bg-live text-white ring-live',
};

export function Badge({ tone = 'neutral', children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset', TONES[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

export function LiveBadge({ className }: { className?: string }) {
  return (
    <Badge tone="live" className={className}>
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden />
      Live
    </Badge>
  );
}

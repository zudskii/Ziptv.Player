import { LoaderCircle } from 'lucide-react';

import { cn } from '../../lib/cn';

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn('flex flex-col items-center gap-3 text-sm text-fg-muted', className)}>
      <LoaderCircle className="h-7 w-7 animate-spin text-brand-soft" aria-hidden />
      {label ? <span>{label}</span> : <span className="sr-only">Loading</span>}
    </div>
  );
}

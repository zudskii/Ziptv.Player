import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

/** Friendly empty/zero state inside a page section. */
export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-xl border border-dashed border-line/10 px-6 py-12 text-center', className)}>
      {icon && <div className="mb-3 text-fg-subtle">{icon}</div>}
      <p className="font-medium text-fg">{title}</p>
      {description && <div className="mt-1 max-w-md text-sm text-fg-muted">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

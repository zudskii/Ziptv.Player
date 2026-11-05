import { AlertTriangle, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';

import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { Button } from './Button';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** The next step — every empty state should offer one when there is one. */
  action?: ReactNode;
  /** `error`: something failed to load (warning icon, announced); `empty`: nothing here yet. */
  tone?: 'empty' | 'error';
  /** For `error`: adds a "Try again" button. */
  onRetry?: () => void;
  className?: string;
}

/**
 * The one way a screen says "nothing here": what is missing, why, and what to do next. Used for
 * empty lists, no search results and failed loads alike, so they look and behave the same.
 */
export function EmptyState({ icon, title, description, action, tone = 'empty', onRetry, className }: EmptyStateProps) {
  const error = tone === 'error';
  return (
    <div
      role={error ? 'alert' : undefined}
      className={cn('flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center', error ? 'border-amber-500/30' : 'border-line/10', className)}
    >
      {(icon ?? error) && <div className={cn('mb-3', error ? 'text-amber-500' : 'text-fg-subtle')}>{icon ?? <AlertTriangle className="h-8 w-8" />}</div>}
      <p className="font-medium text-fg">{title}</p>
      {description && <div className="mt-1 max-w-md text-sm text-fg-muted">{description}</div>}
      {(action || onRetry) && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {onRetry && (
            <Button size="sm" icon={<RotateCw className="h-4 w-4" />} onClick={onRetry}>
              {t('common.retry')}
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

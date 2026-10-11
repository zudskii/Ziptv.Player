import { CircleAlert, Info } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from './Button';

interface FullscreenMessageProps {
  title: string;
  description?: ReactNode;
  tone?: 'info' | 'error';
  icon?: ReactNode;
  action?: { label: string; onClick: () => void };
  children?: ReactNode;
}

export function FullscreenMessage({ title, description, tone = 'info', icon, action, children }: FullscreenMessageProps) {
  const Icon = tone === 'error' ? CircleAlert : Info;
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-16 text-center">
      <div className={tone === 'error' ? 'rounded-full bg-red-500/10 p-3 text-red-400' : 'rounded-full bg-brand/10 p-3 text-brand-soft'}>
        {icon ?? <Icon className="h-7 w-7" aria-hidden />}
      </div>
      <h1 className="mt-5 text-xl font-semibold text-fg">{title}</h1>
      {description && <div className="mt-2 max-w-md text-sm text-fg-muted">{description}</div>}
      {action && (
        <Button variant="primary" className="mt-6" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
      {children}
    </div>
  );
}

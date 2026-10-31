import type { ReactNode } from 'react';

import { Brand } from '../../components/layout/Brand';

/** The frame of the sign-in family of pages: brand, a card, a line of links below. */
export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <Brand />
        </div>
        <div className="card space-y-5 p-5 sm:p-6">
          <div>
            <h1 className="text-xl font-bold text-fg">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>}
          </div>
          {children}
        </div>
        {footer && <p className="text-center text-sm text-fg-muted">{footer}</p>}
      </div>
    </div>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-500">
      {children}
    </div>
  );
}

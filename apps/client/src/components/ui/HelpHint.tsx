import { CircleHelp } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { Floating } from './Tooltip';

/**
 * A "?" next to a setting that explains it on demand (a toggletip): click or Enter opens it, a
 * second click, Escape, moving focus away or clicking elsewhere closes it. Unlike a tooltip it works
 * the same on touch screens and TV remotes, and the text is read out when it opens.
 */
export function HelpHint({ topic, children, className }: { topic: string; children: ReactNode; className?: string }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const open = anchor !== null;
  const close = () => setAnchor(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!anchor?.contains(event.target as Node)) setAnchor(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setAnchor(null);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchor]);

  return (
    <>
      <button
        type="button"
        aria-label={t('help.about', { topic })}
        aria-expanded={open}
        onClick={(event) => setAnchor(open ? null : event.currentTarget)}
        onBlur={close}
        className={cn('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-fg/10 hover:text-fg', open && 'bg-fg/10 text-fg', className)}
      >
        <CircleHelp className="h-4 w-4" aria-hidden />
      </button>
      {/* Present before it is filled, so screen readers announce the text when it appears. */}
      <span role="status" className="sr-only">
        {open ? children : ''}
      </span>
      {anchor && (
        <Floating anchor={anchor} side="bottom" hidden className="max-w-[18rem] px-3 py-2 font-normal leading-relaxed">
          {children}
        </Floating>
      )}
    </>
  );
}

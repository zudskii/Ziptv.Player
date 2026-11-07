import { X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button, IconButton } from '../../components/ui/Button';
import { t } from '../../i18n';
import { useHelp } from './use-help';

export interface TourStep {
  /** The `data-tour` value of the element this step points at. Steps whose element is absent are skipped. */
  target: string;
  title: string;
  body: string;
}

/** Wait a beat after the page renders, so the tour does not appear on top of a loading screen. */
const START_DELAY_MS = 600;
const GAP = 12;
const CARD_WIDTH = 320;

const findTarget = (target: string) => document.querySelector<HTMLElement>(`[data-tour="${target}"]`);

/**
 * A short guided walk through a screen, shown once per profile the first time the screen is used.
 * Each step highlights one control and explains it; Next / Back / Skip, Escape skips. Not modal —
 * the page stays usable — and finishing or skipping both count as seen.
 *
 * `steps` is called when the tour starts (not at render) so its text follows the current language.
 */
export function Tour({ id, steps, enabled = true }: { id: string; steps: () => TourStep[]; enabled?: boolean }) {
  const help = useHelp();
  const tourId = `tour-${id}`;
  const [active, setActive] = useState<TourStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const pending = help.ready && enabled && !help.seen(tourId);

  const stepsRef = useRef(steps);
  useLayoutEffect(() => {
    stepsRef.current = steps;
  });

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      const available = stepsRef.current().filter((step) => findTarget(step.target));
      if (available.length > 0) {
        setIndex(0);
        setActive(available);
      }
    }, START_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const step = active?.[index];
  if (!active || !step) return null;
  const finish = () => {
    setActive(null);
    help.markSeen(tourId);
  };
  return <TourCard step={step} index={index} total={active.length} onBack={() => setIndex(index - 1)} onNext={() => (index === active.length - 1 ? finish() : setIndex(index + 1))} onClose={finish} />;
}

interface TourCardProps {
  step: TourStep;
  index: number;
  total: number;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
}

function TourCard({ step, index, total, onBack, onNext, onClose }: TourCardProps) {
  const titleId = useId();
  const card = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ ring: DOMRect; top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const target = findTarget(step.target);
    if (!target) {
      onNext(); // the element went away (a re-render): move on rather than point at nothing
      return;
    }
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const place = () => {
      const ring = target.getBoundingClientRect();
      const height = card.current?.offsetHeight ?? 160;
      const width = Math.min(CARD_WIDTH, window.innerWidth - 2 * GAP);
      const below = ring.bottom + GAP;
      const above = ring.top - height - GAP;
      // Below, else above; a target too tall for either (a whole grid) gets the card inside its top edge.
      const top = below + height <= window.innerHeight - GAP ? below : above >= GAP ? above : Math.max(GAP, ring.top + GAP);
      const inside = top === Math.max(GAP, ring.top + GAP) && above < GAP;
      const left = Math.min(Math.max(GAP, ring.left + (inside ? GAP : 0)), window.innerWidth - width - GAP);
      setLayout({ ring, top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
    // onNext changes every render; only a new step re-measures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.target]);

  // Keyboard and remote users land on Next — but the tour never takes focus from a field or
  // control the person is already using when it first appears.
  useEffect(() => {
    const busy = document.activeElement && document.activeElement !== document.body;
    if (index > 0 || !busy) card.current?.querySelector<HTMLElement>('[data-tour-primary]')?.focus();
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const last = index === total - 1;
  return createPortal(
    <>
      {layout && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[90] rounded-lg ring-2 ring-brand ring-offset-2 ring-offset-canvas transition-all duration-200"
          style={{ top: layout.ring.top - 4, left: layout.ring.left - 4, width: layout.ring.width + 8, height: layout.ring.height + 8 }}
        />
      )}
      <div
        ref={card}
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-body`}
        style={{ top: layout?.top ?? -9999, left: layout?.left ?? -9999, width: `min(${CARD_WIDTH}px, calc(100vw - ${2 * GAP}px))` }}
        className="fixed z-[95] animate-fade-in rounded-xl border border-line/10 bg-elevated p-4 text-fg shadow-2xl"
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id={titleId} className="font-semibold">
            {step.title}
          </h2>
          <IconButton label={t('help.tour.skip')} tooltip={false} onClick={onClose} className="-mr-2 -mt-2 h-8 w-8">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <p id={`${titleId}-body`} className="mt-1 text-sm text-fg-muted">
          {step.body}
        </p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-xs text-fg-subtle">{t('help.tour.progress', { n: index + 1, total })}</span>
          <div className="flex gap-2">
            {index > 0 && (
              <Button size="sm" variant="ghost" onClick={onBack}>
                {t('help.tour.back')}
              </Button>
            )}
            <Button size="sm" variant="primary" data-tour-primary onClick={onNext}>
              {last ? t('help.tour.done') : t('help.tour.next')}
            </Button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

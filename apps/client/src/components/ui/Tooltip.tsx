import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../../lib/cn';

/** Hover waits a moment (passing over a toolbar should not flash tooltips); keyboard focus does not. */
const HOVER_DELAY_MS = 500;
/** Touch screens have no hover: a long press shows the tooltip. */
const LONG_PRESS_MS = 500;
const TOUCH_VISIBLE_MS = 2500;
const GAP = 8;

type Trigger = ReactElement<{
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  'aria-describedby'?: string;
  ref?: unknown;
}>;

export interface TooltipProps {
  content: ReactNode;
  children: Trigger;
  side?: 'top' | 'bottom';
  /**
   * The trigger already says the same thing to assistive technology (an icon button's aria-label):
   * the tooltip is then only visual and is not announced twice.
   */
  redundant?: boolean;
}

/**
 * A short explanation of a control, shown on mouse hover (after a moment), on keyboard focus (at
 * once — TV remotes and keyboards have no hover) and on a long press on touch screens. Escape hides
 * it. Drawn in a portal at a fixed position, so scroll containers and overflow never clip it.
 */
export function Tooltip({ content, children, side = 'top', redundant = false }: TooltipProps) {
  const id = useId();
  // 'waiting': shown after `delay`; 'open': visible (and hidden again after `delay` when `autoHide`).
  const [state, setState] = useState<{ phase: 'idle' | 'waiting' | 'open'; anchor: HTMLElement | null; delay: number; autoHide: boolean }>({ phase: 'idle', anchor: null, delay: 0, autoHide: false });
  const open = state.phase === 'open';

  useEffect(() => {
    if (state.phase === 'waiting') {
      const timer = window.setTimeout(() => setState((current) => ({ ...current, phase: 'open', autoHide: false })), state.delay);
      return () => window.clearTimeout(timer);
    }
    if (state.phase === 'open' && state.autoHide) {
      const timer = window.setTimeout(() => setState((current) => ({ ...current, phase: 'idle' })), TOUCH_VISIBLE_MS);
      return () => window.clearTimeout(timer);
    }
  }, [state.phase, state.delay, state.autoHide]);

  const show = (anchor: HTMLElement, delay: number) => setState({ phase: delay === 0 ? 'open' : 'waiting', anchor, delay, autoHide: false });
  const hide = () => setState((current) => (current.phase === 'idle' ? current : { ...current, phase: 'idle' }));

  const props = children.props;
  const trigger = cloneElement(children, {
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      props.onPointerEnter?.(event);
      if (event.pointerType === 'mouse') show(event.currentTarget, HOVER_DELAY_MS);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      props.onPointerLeave?.(event);
      if (event.pointerType === 'mouse') hide();
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      props.onPointerDown?.(event);
      if (event.pointerType === 'mouse') hide(); // clicking acts; the tooltip would only cover the result
      else show(event.currentTarget, LONG_PRESS_MS);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      props.onPointerUp?.(event);
      if (event.pointerType === 'mouse') return;
      // A long press that already shows the tooltip keeps it up for a moment; a short tap cancels it.
      setState((current) => (current.phase === 'open' ? { ...current, autoHide: true } : { ...current, phase: 'idle' }));
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      props.onFocus?.(event);
      if (focusVisible(event.currentTarget)) show(event.currentTarget, 0);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      props.onBlur?.(event);
      hide();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      props.onKeyDown?.(event);
      if (event.key === 'Escape' && open) {
        event.stopPropagation(); // close the tooltip, not the dialog around it
        hide();
      }
    },
    ...(!redundant && open ? { 'aria-describedby': [props['aria-describedby'], id].filter(Boolean).join(' ') } : {}),
  });

  return (
    <>
      {trigger}
      {open && state.anchor && (
        <Floating id={id} anchor={state.anchor} side={side} role="tooltip" hidden={redundant}>
          {content}
        </Floating>
      )}
    </>
  );
}

interface FloatingProps {
  anchor: HTMLElement;
  side: 'top' | 'bottom';
  children: ReactNode;
  id?: string;
  role?: string;
  hidden?: boolean;
  className?: string;
}

/** A small bubble next to `anchor`, in a portal at a fixed position; flips side and stays on screen. */
export function Floating({ id, anchor, side, role, hidden = false, className, children }: FloatingProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const bubble = ref.current;
      if (!bubble) return;
      const target = anchor.getBoundingClientRect();
      const { width, height } = bubble.getBoundingClientRect();
      const above = target.top - height - GAP;
      const below = target.bottom + GAP;
      // Prefer the requested side; flip when it would leave the screen.
      const top = side === 'top' ? (above >= GAP ? above : below) : below + height <= window.innerHeight - GAP ? below : Math.max(GAP, above);
      const left = Math.min(Math.max(GAP, target.left + target.width / 2 - width / 2), Math.max(GAP, window.innerWidth - width - GAP));
      setPosition({ top, left });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor, side]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role={role}
      aria-hidden={hidden || undefined}
      style={{ top: position?.top ?? -9999, left: position?.left ?? -9999 }}
      className={cn('pointer-events-none fixed z-[100] max-w-xs rounded-md bg-fg px-2 py-1 text-xs font-medium text-canvas shadow-lg', position ? 'animate-fade-in' : 'opacity-0', className)}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Keyboard focus (not a mouse click) — the tooltip should not pop up under the pointer after a click. */
function focusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

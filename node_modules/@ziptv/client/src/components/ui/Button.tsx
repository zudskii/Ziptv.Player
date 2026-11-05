import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';

import { cn } from '../../lib/cn';
import { Tooltip } from './Tooltip';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-strong shadow-lg shadow-brand/20',
  secondary: 'bg-fg/5 text-fg ring-1 ring-inset ring-line/10 hover:bg-fg/10',
  ghost: 'text-fg-muted hover:bg-fg/5 hover:text-fg',
  danger: 'bg-red-500/10 text-red-500 ring-1 ring-inset ring-red-500/30 hover:bg-red-500/20',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 gap-1.5 rounded-md px-2.5 text-xs',
  md: 'h-10 gap-2 rounded-lg px-3.5 text-sm',
  lg: 'h-12 gap-2.5 rounded-xl px-5 text-base',
};

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

const BASE = 'inline-flex shrink-0 items-center justify-center font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';

export function Button({ variant = 'secondary', size = 'md', icon, loading = false, className, children, disabled, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} disabled={disabled || loading} className={cn(BASE, VARIANTS[variant], SIZES[size], className)} {...props}>
      {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : icon}
      {children}
    </button>
  );
}

/**
 * A navigation that looks like a button: one `<a>`, not a button inside a link (two nested
 * interactive elements confuse keyboards and screen readers).
 */
export function ButtonLink({ variant = 'secondary', size = 'md', icon, className, children, ...props }: LinkProps & { variant?: Variant; size?: Size; icon?: ReactNode }) {
  return (
    <Link className={cn(BASE, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand', VARIANTS[variant], SIZES[size], className)} {...props}>
      {icon}
      {children}
    </Link>
  );
}

export interface IconButtonProps extends ComponentPropsWithRef<'button'> {
  /** Required: used for aria-label and the tooltip. */
  label: string;
  active?: boolean;
  /** `onDark` for controls drawn over video (always white). */
  tone?: 'default' | 'onDark';
  /** Where the tooltip appears; `false` turns it off (the label is then only for screen readers). */
  tooltip?: 'top' | 'bottom' | false;
}

export function IconButton({ label, active = false, tone = 'default', tooltip = 'top', className, children, type = 'button', ...props }: IconButtonProps) {
  const button = (
    <button
      type={type}
      aria-label={label}
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40',
        tone === 'onDark'
          ? active
            ? 'bg-white/20 text-white'
            : 'text-white/90 hover:bg-white/15 hover:text-white'
          : active
            ? 'bg-brand/15 text-brand-soft'
            : 'text-fg-muted hover:bg-fg/10 hover:text-fg',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
  return tooltip ? (
    <Tooltip content={label} side={tooltip} redundant>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-strong shadow-lg shadow-brand/20',
  secondary: 'bg-white/5 text-slate-100 ring-1 ring-inset ring-white/10 hover:bg-white/10',
  ghost: 'text-slate-300 hover:bg-white/5 hover:text-white',
  danger: 'bg-red-500/10 text-red-300 ring-1 ring-inset ring-red-500/30 hover:bg-red-500/20',
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

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ComponentPropsWithRef<'button'> {
  /** Required: used for aria-label and the tooltip. */
  label: string;
  active?: boolean;
}

export function IconButton({ label, active = false, className, children, type = 'button', ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40',
        active ? 'bg-brand/20 text-brand-soft' : 'text-slate-200 hover:bg-white/10 hover:text-white',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

import { clsx } from 'clsx';
import { Loader2, X } from 'lucide-react';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

type Tone = 'primary' | 'ghost' | 'danger';

export function Button({ tone = 'ghost', busy, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        tone === 'primary' && 'bg-accent text-black hover:bg-accent-soft',
        tone === 'ghost' && 'border border-line/10 bg-surface-2 text-fg hover:bg-line/10',
        tone === 'danger' && 'border border-danger/40 bg-danger/10 text-red-300 hover:bg-danger/20',
        className,
      )}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm text-fg-muted">
        {label}
      </label>
      <input {...props} id={id} aria-describedby={hint ? `${id}-hint` : undefined} className={clsx('field', props.className)} />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-fg-subtle">
          {hint}
        </p>
      )}
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium',
        tone === 'neutral' && 'bg-line/10 text-fg-muted',
        tone === 'ok' && 'bg-ok/15 text-green-300',
        tone === 'warn' && 'bg-accent/15 text-amber-300',
        tone === 'danger' && 'bg-danger/15 text-red-300',
        tone === 'accent' && 'bg-accent text-black',
      )}
    >
      {children}
    </span>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-red-300">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-fg-muted" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

export function DataTable<T>({ rows, columns, rowKey, empty = 'Nothing here yet.', label }: { rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; empty?: string; label: string }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm" aria-label={label}>
        <thead className="border-b border-line/[0.07] text-xs uppercase tracking-wide text-fg-subtle">
          <tr>
            {columns.map((column) => (
              <th key={column.header} scope="col" className={clsx('px-4 py-3 font-medium', column.className)}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-fg-muted">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className="border-b border-line/[0.05] last:border-0 hover:bg-line/[0.03]">
                {columns.map((column) => (
                  <td key={column.header} className={clsx('px-4 py-3 align-top', column.className)}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={title} className="w-full max-w-md rounded-xl border border-line/10 bg-surface p-0 text-fg backdrop:bg-black/60">
      <div className="flex items-center justify-between border-b border-line/[0.07] px-5 py-4">
        <h2 className="font-semibold">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-fg-muted hover:bg-line/10">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-4 px-5 py-4">{children}</div>
    </dialog>
  );
}

export function Stat({ label, value, note, tone }: { label: string; value: number | string; note?: string; tone?: 'warn' | 'danger' }) {
  return (
    <div className="card p-4">
      <p className="text-xs uppercase tracking-wide text-fg-subtle">{label}</p>
      <p className={clsx('mt-2 text-2xl font-semibold tabular-nums', tone === 'warn' && 'text-amber-300', tone === 'danger' && 'text-red-300')}>{value}</p>
      {note && <p className="mt-1 text-xs text-fg-muted">{note}</p>}
    </div>
  );
}

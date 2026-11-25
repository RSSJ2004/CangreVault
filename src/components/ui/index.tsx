import { useEffect, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { formatMoney, type Cents } from '@/domain/money';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'income' | 'expense';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 shadow-sm',
  secondary: 'bg-white text-ink border border-line hover:bg-brand-50',
  ghost: 'text-brand-700 hover:bg-brand-50',
  danger: 'bg-white text-red-700 border border-red-200 hover:bg-red-50',
  income: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
  expense: 'bg-orange-700 text-white hover:bg-orange-800 shadow-sm',
};

export function Button({ variant = 'primary', size = 'md', className, loading, children, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' && 'px-2.5 py-1.5 text-sm', size === 'md' && 'px-4 py-2 text-sm', size === 'lg' && 'px-5 py-3 text-base',
        variants[variant], className,
      )}
    >
      {loading && <Spinner small />}
      {children}
    </button>
  );
}

export function Card({ className, children, as: As = 'section' }: { className?: string; children: ReactNode; as?: 'section' | 'div' | 'article' }) {
  return <As className={cx('rounded-xl border border-line bg-surface p-4 sm:p-5', className)}>{children}</As>;
}

export function CardTitle({ children, action, hint }: { children: ReactNode; action?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">{children}</h2>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function Money({ value, currency = 'DOP', tone = 'none', sign, className }:
  { value: Cents; currency?: string; tone?: 'auto' | 'none' | 'pos' | 'neg'; sign?: boolean; className?: string }) {
  const t = tone === 'auto' ? (value > 0 ? 'pos' : value < 0 ? 'neg' : 'none') : tone;
  return (
    <span className={cx('tabular whitespace-nowrap', t === 'pos' && 'text-pos', t === 'neg' && 'text-neg', className)}>
      {formatMoney(value, currency, { sign })}
    </span>
  );
}

export function Stat({ label, value, hint, tone, emphasis }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'pos' | 'neg' | 'warn'; emphasis?: boolean }) {
  return (
    <div className={cx('rounded-xl border bg-surface p-4', emphasis ? 'border-brand-200 bg-brand-50/60' : 'border-line')}>
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={cx('mt-1 text-xl font-semibold tabular', tone === 'pos' && 'text-pos', tone === 'neg' && 'text-neg', tone === 'warn' && 'text-amber-700')}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'pos' | 'neg' | 'warn' | 'info' | 'ai'; children: ReactNode; title?: string }) {
  const tones = {
    neutral: 'bg-slate-100 text-slate-700', pos: 'bg-emerald-50 text-emerald-700', neg: 'bg-orange-50 text-orange-800',
    warn: 'bg-amber-50 text-amber-800', info: 'bg-sky-50 text-sky-800', ai: 'bg-violet-50 text-violet-800',
  };
  return <span title={title} className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', tones[tone])}>{children}</span>;
}

export function Field({ label, error, hint, children, className }: { label: string; error?: string | null; hint?: ReactNode; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted">{label}</label>
      {children(id)}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && <p className="text-xs text-red-700" role="alert">{error}</p>}
    </div>
  );
}

const inputCls = 'rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';

/** Ancho por defecto w-full salvo que el llamador indique otro ancho (evita conflictos de precedencia CSS). */
const width = (cls?: string) => (cls && /(^|\s)(w-|min-w-)/.test(cls) ? '' : 'w-full');

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputCls, width(props.className), props.className)} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputCls, width(props.className), 'pr-8', props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputCls, width(props.className), props.className)} />;
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={cx('max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-slate-100" aria-label="Cerrar">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ProgressBar({ pct, tone = 'brand', marker }: { pct: number; tone?: 'brand' | 'warn' | 'neg'; marker?: number }) {
  const c = tone === 'warn' ? 'bg-amber-500' : tone === 'neg' ? 'bg-orange-700' : 'bg-brand-500';
  return (
    <div className="relative h-2 w-full rounded-full bg-slate-100">
      <div className={cx('h-2 rounded-full transition-all', c)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      {marker !== undefined && <div className="absolute -top-1 h-4 w-0.5 bg-ink/50" style={{ left: `${Math.min(100, marker)}%` }} title={`${marker}%`} />}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-semibold text-brand-900 sm:text-[28px]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-white/60 p-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={cx('inline-block animate-spin rounded-full border-2 border-current border-t-transparent', small ? 'h-3.5 w-3.5' : 'h-6 w-6 text-brand-600')} aria-label="Cargando" />;
}

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return <div className="flex items-center gap-3 p-8 text-sm text-muted"><Spinner /> {label}</div>;
}

export function ErrorBox({ error, title = 'Algo salió mal' }: { error: unknown; title?: string }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : String(error);
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      <strong className="font-semibold">{title}: </strong>{msg}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'ok'; children: ReactNode }) {
  const cls = tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-900' : tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-sky-200 bg-sky-50 text-sky-900';
  return <div className={cx('rounded-lg border p-3 text-sm', cls)}>{children}</div>;
}

export function BarList({ items, total }: { items: { label: string; value: Cents; pct?: number }[]; total?: Cents }) {
  const maxVal = Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return (
    <ul className="space-y-2.5">
      {items.map((i) => (
        <li key={i.label}>
          <div className="mb-1 flex justify-between gap-2 text-sm">
            <span className="truncate">{i.label}</span>
            <span className="tabular text-muted">{formatMoney(i.value)}{i.pct !== undefined && <span className="ml-1.5 text-xs">({i.pct}%)</span>}</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-100">
            <div className="h-1.5 rounded-full bg-brand-500" style={{ width: `${(Math.abs(i.value) / (total ? Math.max(1, total) : maxVal)) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

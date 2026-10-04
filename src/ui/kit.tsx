// Small UI kit: thin borders instead of shadows, system font, generous spacing.
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ')
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg' }

export function Button({ variant = 'secondary', size = 'md', className, ...p }: BtnProps) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer select-none',
        size === 'sm' && 'h-7 px-2.5 text-[13px]',
        size === 'md' && 'h-9 px-3.5 text-sm',
        size === 'lg' && 'h-11 px-5 text-[15px] w-full',
        variant === 'primary' && 'bg-accent text-accent-ink hover:brightness-110',
        variant === 'secondary' && 'border border-line bg-surface hover:bg-sunken',
        variant === 'ghost' && 'text-muted hover:text-ink hover:bg-sunken',
        variant === 'danger' && 'border border-line text-bad hover:bg-sunken',
        className,
      )}
    />
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-xl border border-line bg-surface', className)}>{children}</div>
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'muted' | 'accent' }) {
  const color = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', muted: 'bg-faint', accent: 'bg-accent' }[tone]
  return <span aria-hidden className={cx('inline-block size-2 shrink-0 rounded-full', color)} />
}

export function Chip({ children, tone = 'muted', title }: { children: ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'bad'; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs',
        tone === 'muted' && 'border-line text-muted',
        tone === 'ok' && 'border-ok/40 text-ok',
        tone === 'warn' && 'border-warn/40 text-warn',
        tone === 'bad' && 'border-bad/40 text-bad',
      )}
    >
      {children}
    </span>
  )
}

const control = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm placeholder:text-faint focus:border-accent focus:outline-none'

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx(control, 'h-9 py-0', p.className)} />
}

export function TextArea(p: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx(control, 'min-h-20 resize-y', p.className)} />
}

export function Select({ children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...p} className={cx(control, 'h-9 py-0', p.className)}>
      {children}
    </select>
  )
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('flex flex-col gap-1.5', className)}>
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  )
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full border border-line transition-colors', checked ? 'bg-accent' : 'bg-sunken')}
      >
        <span className={cx('absolute top-0.5 size-3.5 rounded-full bg-surface transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      <span className="flex flex-col">
        <span className="text-sm">{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </span>
    </label>
  )
}

export function Spinner() {
  return <span aria-label="Working" className="inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>
}

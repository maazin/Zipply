// Small UI kit: thin borders and a hairline of shadow, system font, generous
// spacing, and the logo's gradient on the one main button.
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { LOGO_SVG } from '@/shared/logo'

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ')
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger'; size?: 'sm' | 'md' | 'lg' }

export function Button({ variant = 'secondary', size = 'md', className, ...p }: BtnProps) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer select-none',
        size === 'sm' && 'h-7 px-2.5 text-[13px]',
        size === 'md' && 'h-9 px-3.5 text-sm',
        size === 'lg' && 'h-11 px-5 text-[15px]',
        variant === 'primary' && 'bg-linear-to-r from-brand-from to-brand-to text-white shadow-sm shadow-brand-to/30 hover:brightness-110 active:brightness-95',
        variant === 'secondary' && 'border border-line bg-surface shadow-xs hover:bg-sunken',
        variant === 'ghost' && 'text-muted hover:text-ink hover:bg-sunken',
        // Something the AI does: tinted, so it stands apart from plain actions.
        variant === 'soft' && 'bg-accent/10 text-accent hover:bg-accent/15',
        variant === 'danger' && 'border border-line text-bad hover:bg-sunken',
        className,
      )}
    />
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-xl border border-line bg-surface shadow-xs', className)}>{children}</div>
}

/** A small heading over a group inside a card. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('text-[11px] font-semibold uppercase tracking-wide text-faint', className)}>{children}</div>
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'muted' | 'accent' }) {
  const color = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', muted: 'bg-faint', accent: 'bg-accent' }[tone]
  return <span aria-hidden className={cx('inline-block size-2 shrink-0 rounded-full', color)} />
}

export function Chip({ children, tone = 'muted', title, dashed }: { children: ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'bad' | 'accent'; title?: string; dashed?: boolean }) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium',
        dashed && 'border-dashed',
        tone === 'muted' && 'border-line text-muted',
        tone === 'ok' && 'border-ok/25 bg-ok/10 text-ok',
        tone === 'warn' && 'border-warn/25 bg-warn/10 text-warn',
        tone === 'bad' && 'border-bad/25 bg-bad/10 text-bad',
        tone === 'accent' && 'border-accent/25 bg-accent/10 text-accent',
      )}
    >
      {children}
    </span>
  )
}

/** A score out of 100 as a ring, colored by how good it is. "—" when there's none. */
export function ScoreRing({ score, size = 64, label }: { score: number | null; size?: number; label?: string }) {
  const r = 15.5
  const c = 2 * Math.PI * r
  const tone = score == null ? 'text-faint' : score >= 75 ? 'text-ok' : score >= 50 ? 'text-warn' : 'text-bad'
  return (
    <span className={cx('relative inline-grid shrink-0 place-items-center', tone)} style={{ width: size, height: size }} role="img" aria-label={score == null ? 'No score' : `${label ?? 'Score'} ${score}`}>
      <svg viewBox="0 0 36 36" width={size} height={size} className="-rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeOpacity=".15" strokeWidth="3.5" />
        {score != null && <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${(Math.max(0, Math.min(100, score)) / 100) * c} ${c}`} />}
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="text-lg font-bold tabular-nums text-ink">{score ?? '—'}</span>
        {label && <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-faint">{label}</span>}
      </span>
    </span>
  )
}

const ICONS = {
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 8v5M12 16.5v.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  minus: 'M6 12h12',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z',
  pause: 'M9 5v14M15 5v14',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  sheet: 'M4 4h16v16H4zM4 10h16M4 15h16M10 4v16',
  flag: 'M4 22V4M4 4h12l-2 4 2 4H4',
} as const

/** A small line icon. */
export function Icon({ name, size = 14, className }: { name: keyof typeof ICONS; size?: number; className?: string }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={cx('shrink-0', className)}>
      <path d={ICONS[name]} />
    </svg>
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

/** Zipply's logo. */
export function Logo({ size = 18 }: { size?: number }) {
  return <span aria-hidden className="inline-block shrink-0" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: LOGO_SVG.replace('<svg ', '<svg width="100%" height="100%" ') }} />
}

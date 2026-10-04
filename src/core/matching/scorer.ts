import type { FieldDescriptor, FieldKind } from '@/shared/types'
import { KEY_DEFS, type KeyDef, type ProfileKey } from '@/shared/profileKeys'
import { normalizeIdentifier, normalizeLabel, tokens } from '@/shared/text'

/**
 * How much each signal is trusted (from fillwright's weighted field signals).
 * A label match is nearly as good as a correct autocomplete attribute; nearby
 * text is a weak hint.
 */
export const SIGNAL_WEIGHTS = {
  autocomplete: 1.0,
  label: 0.97,
  ariaLabel: 0.93,
  name: 0.86,
  id: 0.8,
  placeholder: 0.8,
  nearby: 0.62,
} as const

export type SignalName = keyof typeof SIGNAL_WEIGHTS

export interface Signal {
  name: SignalName
  text: string
}

export function signalsFor(f: FieldDescriptor): Signal[] {
  const out: Signal[] = []
  const push = (name: SignalName, raw: string, ident = false) => {
    const text = ident ? normalizeIdentifier(raw) : normalizeLabel(raw)
    if (text) out.push({ name, text })
  }
  push('label', f.label)
  push('ariaLabel', f.ariaLabel)
  push('name', f.name, true)
  push('id', f.idAttr, true)
  push('placeholder', f.placeholder)
  push('nearby', f.nearbyText)
  return out
}

const OPEN_QUESTION = /^(why|what|describe|tell|how|explain|share|please describe|briefly|in a few)\b/

/** How well one normalized signal text matches one alias, 0..1. */
export function phraseScore(text: string, alias: string): number {
  if (text === alias) return 1
  const tt = text.split(' ')
  const at = alias.split(' ')
  const padded = ` ${text} `
  if (padded.includes(` ${alias} `)) {
    // A multi-word alias inside a label is strong evidence; a one-word alias
    // inside a long question is weak ("company" in "why our company?").
    const ratio = at.length / tt.length
    if (at.length >= 2) return Math.max(0.82, 0.9 * Math.min(1, 0.6 + ratio))
    if (tt.length <= 3) return 0.88
    if (tt.length <= 6) return 0.72
    return 0.55
  }
  // Token overlap for reordered phrases ("name first" vs "first name").
  const A = new Set(tokens(text))
  const B = new Set(tokens(alias))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of B) if (A.has(t)) inter++
  if (!inter) return 0
  const coverage = inter / B.size
  const precision = inter / A.size
  return 0.75 * coverage * Math.sqrt(precision)
}

function kindAllowed(def: KeyDef, kind: FieldKind): boolean {
  if (kind === 'file') return def.kinds?.includes('file') ?? false
  if (def.kinds) return def.kinds.includes(kind) || (kind === 'combobox' && def.kinds.includes('select'))
  return true
}

/** Type-level hints that work like an autocomplete attribute. */
function typeBoost(def: KeyDef, f: FieldDescriptor): number {
  if (f.kind === 'email' && def.key === 'email') return 0.97
  if (f.kind === 'tel' && def.key === 'phone') return 0.95
  return 0
}

export interface KeyScore {
  key: ProfileKey
  score: number
  via: SignalName | 'type'
}

export function scoreField(f: FieldDescriptor, defs: KeyDef[] = KEY_DEFS): KeyScore[] {
  const sigs = signalsFor(f)
  const ac = f.autocomplete.toLowerCase().split(/\s+/).filter((t) => t && t !== 'on' && t !== 'off')
  const labelText = normalizeLabel(f.label || f.ariaLabel)
  const isQuestion = OPEN_QUESTION.test(labelText) && labelText.split(' ').length > 5
  const out: KeyScore[] = []

  for (const def of defs) {
    if (!kindAllowed(def, f.kind)) continue
    let best = 0
    let via: KeyScore['via'] = 'label'
    if (def.autocomplete && ac.some((t) => def.autocomplete!.includes(t))) {
      best = SIGNAL_WEIGHTS.autocomplete
      via = 'autocomplete'
    }
    const tb = typeBoost(def, f)
    if (tb > best) {
      best = tb
      via = 'type'
    }
    for (const s of sigs) {
      let m = 0
      for (const alias of def.aliases) m = Math.max(m, phraseScore(s.text, alias))
      const v = m * SIGNAL_WEIGHTS[s.name]
      if (v > best) {
        best = v
        via = s.name
      }
    }
    // Open-ended questions and long text areas rarely want a short profile value.
    if (isQuestion && !def.boolean && !def.sensitive && def.key !== 'summary' && def.key !== 'coverLetter') best *= 0.6
    if (f.kind === 'textarea' && !['summary', 'coverLetter', 'addressLine1'].includes(def.key)) best *= 0.75
    // "Name" alone means full name; "Company name" or "First name" do not.
    if (def.key === 'fullName' && /\b(first|last|middle|family|given|preferred|company|school|reference|manager|referrer|user)\b/.test(labelText + ' ' + normalizeIdentifier(f.name)))
      best *= 0.4
    if (best > 0) out.push({ key: def.key, score: Math.min(1, best), via })
  }
  return out.sort((a, b) => b.score - a.score)
}

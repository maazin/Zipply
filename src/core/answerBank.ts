import type { AnswerBankEntry, FieldKind } from '@/shared/types'
import { bigramSimilarity, jaccard, normalizeLabel } from '@/shared/text'

/** Similarity of two question labels, 0..1. */
export function labelSimilarity(a: string, b: string): number {
  const na = normalizeLabel(a)
  const nb = normalizeLabel(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  return Math.max(jaccard(na, nb), bigramSimilarity(na, nb) * 0.95)
}

const CHOICE_KINDS: FieldKind[] = ['select', 'combobox', 'radio', 'checkbox', 'checkbox-group']

function compatible(a: FieldKind, b: FieldKind): boolean {
  if (a === b) return true
  const ca = CHOICE_KINDS.includes(a)
  const cb = CHOICE_KINDS.includes(b)
  return ca === cb
}

/** Best saved answer for a question, if one is close enough (default 0.85). */
export function findAnswer(
  label: string,
  kind: FieldKind,
  bank: AnswerBankEntry[],
  min = 0.85,
): { entry: AnswerBankEntry; similarity: number } | null {
  let best: { entry: AnswerBankEntry; similarity: number } | null = null
  for (const e of bank) {
    if (!compatible(kind, e.fieldKind)) continue
    const s = labelSimilarity(label, e.label)
    if (s >= min && (!best || s > best.similarity || (s === best.similarity && e.updatedAt > best.entry.updatedAt)))
      best = { entry: e, similarity: s }
  }
  return best
}

/** Labels too generic or too personal to remember. */
export function shouldRemember(label: string, key: string | undefined, value: string, kind: FieldKind): boolean {
  if (!value.trim() || kind === 'file') return false
  // Profile fields have one source of truth: the profile.
  if (key) return false
  const n = normalizeLabel(label)
  if (n.split(' ').length < 2) return false
  if (/password|captcha|ssn|social security|date of birth|credit card|signature/.test(n)) return false
  // Sensitive answers live in Standard answers, never in the bank.
  if (/gender|race|ethnic|hispanic|veteran|disability|sponsor|salary|compensation/.test(n)) return false
  return true
}

/** Insert or update an entry by normalized label (overwrite, from Auto_job_applier_linkedIn). */
export function upsertAnswer(
  bank: AnswerBankEntry[],
  entry: Omit<AnswerBankEntry, 'labelNorm' | 'uses' | 'updatedAt'>,
  now = Date.now(),
): AnswerBankEntry[] {
  const labelNorm = normalizeLabel(entry.label)
  const i = bank.findIndex((e) => e.labelNorm === labelNorm && compatible(e.fieldKind, entry.fieldKind))
  if (i >= 0) {
    const next = bank.slice()
    next[i] = { ...bank[i], ...entry, id: bank[i].id, labelNorm, updatedAt: now, uses: bank[i].uses }
    return next
  }
  return [...bank, { ...entry, labelNorm, updatedAt: now, uses: 0 }]
}

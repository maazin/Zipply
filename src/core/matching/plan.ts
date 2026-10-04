import type { AnswerBankEntry, FieldDescriptor, FillSource, Profile } from '@/shared/types'
import { KEY_DEF, KEY_DEFS, valueFor, type ProfileKey } from '@/shared/profileKeys'
import { findBadWord, normalizeLabel } from '@/shared/text'
import { findAnswer } from '../answerBank'
import { hungarian } from './hungarian'
import { pickOption } from './options'
import { scoreField } from './scorer'

/**
 * Checkbox labels that carry legal weight. None of these is ever auto-ticked
 * (rule from Auto_job_applier_linkedIn's attestation_terms).
 */
export const ATTESTATION_TERMS = [
  'certify', 'certifies', 'certification', 'attest', 'attestation', 'consent', 'consents', 'agree', 'agreement',
  'terms', 'conditions', 'policy', 'acknowledge', 'acknowledgement', 'acknowledgment', 'authorize', 'authorise',
  'background check', 'drug test', 'drug screen', 'accurate', 'true and complete', 'i understand', 'i confirm',
  'privacy', 'sms', 'text messages', 'marketing',
]

export interface PlanItem {
  zid: string
  key?: ProfileKey
  /** Text to type, or the option label to choose. */
  value?: string
  /** For choice fields: index into field.options. */
  optionIndex?: number
  /** For single checkboxes. */
  checked?: boolean
  confidence: number
  source: FillSource
  /** Answer bank entry used, when source is 'bank'. */
  bankId?: string
  action: 'fill' | 'skip' | 'unresolved'
  status: 'filled' | 'low' | 'skipped'
  reason?: string
}

export interface PlanOptions {
  threshold: number
  /** Adapter-provided mappings, trusted as-is. */
  explicit?: Map<string, ProfileKey>
  bank?: AnswerBankEntry[]
  /** Keys the matcher should not assign (e.g. handled by repeating sections). */
  excludeKeys?: ProfileKey[]
}

const CHOICE = new Set(['select', 'combobox', 'radio', 'checkbox-group'])

/** Turn a key + field into a concrete fill action. */
export function resolveValue(
  f: FieldDescriptor,
  key: ProfileKey,
  profile: Profile,
  confidence: number,
  source: FillSource,
  strong: boolean,
): PlanItem {
  const def = KEY_DEF[key]
  const base = { zid: f.zid, key, confidence, source }
  if (key === 'resume' || (key === 'coverLetter' && f.kind === 'file')) {
    return { ...base, action: 'fill', status: 'filled', value: key }
  }
  if (key === 'coverLetter') {
    return { ...base, action: 'unresolved', status: 'skipped', reason: 'Cover letter: generate one from the panel' }
  }
  const value = valueFor(profile, key)
  if (!value) {
    return {
      ...base,
      action: 'skip',
      status: 'skipped',
      reason: def.sensitive ? `${def.label} isn't set in your profile, so it was left for you` : `${def.label} is empty in your profile`,
    }
  }
  const status = strong ? 'filled' : 'low'

  if (f.kind === 'checkbox') {
    const label = normalizeLabel(f.label)
    if (findBadWord(label, ATTESTATION_TERMS)) {
      return { ...base, action: 'skip', status: 'skipped', reason: 'Needs your confirmation' }
    }
    if (!def.boolean) return { ...base, action: 'skip', status: 'skipped', reason: 'Not a yes/no answer' }
    return { ...base, action: 'fill', status, checked: value === 'Yes', value }
  }

  if (CHOICE.has(f.kind) && f.options.length) {
    const pick = pickOption(f.options, value, { boolean: def.boolean })
    if (pick.index < 0) {
      return { ...base, action: 'skip', status: 'skipped', reason: `No option matches "${value}"` }
    }
    return {
      ...base,
      action: 'fill',
      status: strong && pick.confidence >= 0.85 ? 'filled' : 'low',
      value: f.options[pick.index],
      optionIndex: pick.index,
      confidence: confidence * pick.confidence,
    }
  }

  if (f.kind === 'date') {
    // input[type=date] wants YYYY-MM-DD.
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : ''
    if (!iso) return { ...base, action: 'skip', status: 'skipped', reason: `"${value}" isn't a date` }
    return { ...base, action: 'fill', status, value: iso }
  }

  return { ...base, action: 'fill', status, value }
}

/**
 * Map every field on the page to a profile value. Order: adapter mappings, then
 * strong rule matches and the answer bank, then weaker rule matches. Anything
 * left is "unresolved" and may go to the AI mapper (labels only).
 */
export function planFields(fields: FieldDescriptor[], profile: Profile, opts: PlanOptions): PlanItem[] {
  const explicit = opts.explicit ?? new Map()
  const bank = opts.bank ?? []
  const plans = new Map<string, PlanItem>()
  const used = new Set<ProfileKey>(opts.excludeKeys ?? [])

  for (const f of fields) {
    const key = explicit.get(f.zid)
    if (!key) continue
    plans.set(f.zid, resolveValue(f, key, profile, 1, 'adapter', true))
    used.add(key)
  }

  const rest = fields.filter((f) => !plans.has(f.zid))
  const keys = KEY_DEFS.map((d) => d.key).filter((k) => !used.has(k))
  const scores = rest.map((f) => {
    const m = new Map<ProfileKey, number>()
    for (const s of scoreField(f)) m.set(s.key, s.score)
    return m
  })
  const cost = scores.map((m) => keys.map((k) => 1 - (m.get(k) ?? 0)))
  const assignment = keys.length ? hungarian(cost) : rest.map(() => -1)

  rest.forEach((f, i) => {
    const col = assignment[i]
    const key = col >= 0 ? keys[col] : undefined
    const score = key ? scores[i].get(key) ?? 0 : 0
    const hit = f.kind === 'file' ? null : findAnswer(f.label || f.ariaLabel || f.placeholder, f.kind, bank)

    if (key && score >= 0.9) {
      plans.set(f.zid, resolveValue(f, key, profile, score, 'rules', true))
    } else if (hit) {
      const strong = hit.similarity >= 0.95
      if (f.kind === 'checkbox') {
        plans.set(f.zid, {
          zid: f.zid,
          confidence: hit.similarity,
          source: 'bank',
          bankId: hit.entry.id,
          action: 'fill',
          status: strong ? 'filled' : 'low',
          checked: /^(yes|true|checked|on)$/i.test(hit.entry.answer),
          value: hit.entry.answer,
        })
      } else if (CHOICE.has(f.kind)) {
        const pick = pickOption(f.options, hit.entry.answer)
        plans.set(
          f.zid,
          pick.index >= 0
            ? { zid: f.zid, confidence: hit.similarity, source: 'bank', bankId: hit.entry.id, action: 'fill', status: strong ? 'filled' : 'low', value: f.options[pick.index], optionIndex: pick.index }
            : { zid: f.zid, confidence: 0, source: 'bank', action: 'unresolved', status: 'skipped', reason: 'Saved answer no longer matches the options' },
        )
      } else {
        plans.set(f.zid, { zid: f.zid, confidence: hit.similarity, source: 'bank', bankId: hit.entry.id, action: 'fill', status: strong ? 'filled' : 'low', value: hit.entry.answer })
      }
    } else if (key && score >= opts.threshold) {
      plans.set(f.zid, resolveValue(f, key, profile, score, 'rules', false))
    } else if (f.kind === 'checkbox' && findBadWord(normalizeLabel(f.label), ATTESTATION_TERMS)) {
      plans.set(f.zid, { zid: f.zid, confidence: 0, source: 'none', action: 'skip', status: 'skipped', reason: 'Needs your confirmation' })
    } else {
      plans.set(f.zid, { zid: f.zid, confidence: score, source: 'none', action: 'unresolved', status: 'skipped', reason: 'No confident match' })
    }
  })

  return fields.map((f) => plans.get(f.zid)!)
}

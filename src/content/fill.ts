// Fill one page: adapter mappings, repeating sections, rules + answer bank, then
// the AI field mapper for leftovers (labels only), then drafts for open questions.
// Never clicks Next or Submit.
import type { FieldReport, FillSource, FieldStatus } from '@/shared/types'
import type { AiText, FillContext } from '@/shared/messages'
import { isError, send } from '@/shared/messages'
import { KEY_DEF, type ProfileKey } from '@/shared/profileKeys'
import { planFields, resolveValue, type PlanItem } from '@/core/matching/plan'
import { shouldRemember } from '@/core/answerBank'
import { collectFields, findByZid, readValue, type Collected } from './dom/collect'
import { humanPause, setCheckboxGroup, setChecked, setCombobox, setFile, setRadio, setSelect, setText } from './dom/setValue'
import type { Adapter } from './adapters'

const MAX_DRAFTS_PER_PAGE = 4

export interface Tracked {
  c: Collected
  key?: ProfileKey
  source: FillSource
  draft?: string
}

/** Fields we filled or left for the user, by zid. Used for answer-bank capture and report refresh. */
export const tracked = new Map<string, Tracked>()
export let lastReports: FieldReport[] = []

function isQuestion(c: Collected): boolean {
  const label = c.desc.label || c.desc.ariaLabel || c.desc.placeholder
  if (c.desc.kind === 'textarea') return label.length > 3
  return c.desc.kind === 'text' && (label.trim().endsWith('?') || label.split(' ').length >= 7)
}

const SENSITIVE_Q = /salary|compensation|pay|sponsor|visa|authori[sz]ed|citizen|gender|race|ethnic|veteran|disabilit|criminal|convicted|age|birth|ssn|social security/i

async function apply(c: Collected, item: PlanItem, ctx: FillContext): Promise<{ status: FieldStatus; reason?: string }> {
  const el = c.el as HTMLElement
  const kind = c.desc.kind
  if (kind === 'file') {
    if (item.key !== 'resume') return { status: 'skipped', reason: 'Attach this file yourself' }
    if (!ctx.resume) return { status: 'skipped', reason: 'Add a resume on the Profile page' }
    return setFile(el as HTMLInputElement, ctx.resume) ? { status: 'filled' } : { status: 'skipped', reason: "Couldn't attach the file" }
  }
  // Don't overwrite something already there unless we're confident.
  const current = readValue(c)
  if (current && item.status !== 'filled' && kind !== 'checkbox') return { status: 'skipped', reason: 'Already had a value' }

  switch (kind) {
    case 'select':
      if (item.optionIndex == null) return { status: 'skipped', reason: 'No matching option' }
      setSelect(el as HTMLSelectElement, item.optionIndex)
      break
    case 'radio':
      if (item.optionIndex == null || !c.members) return { status: 'skipped', reason: 'No matching option' }
      setRadio(c.members, item.optionIndex)
      break
    case 'checkbox-group':
      if (item.optionIndex == null || !c.members) return { status: 'skipped', reason: 'No matching option' }
      setCheckboxGroup(c.members, item.optionIndex)
      break
    case 'checkbox':
      setChecked(el as HTMLInputElement, Boolean(item.checked))
      break
    case 'combobox': {
      const chosen = await setCombobox(el, item.value ?? '', { boolean: item.key ? KEY_DEF[item.key]?.boolean : false })
      if (!chosen) return { status: 'skipped', reason: `No option matches "${item.value}"` }
      return { status: item.status === 'filled' && item.source !== 'ai-map' ? 'filled' : 'low' }
    }
    default:
      setText(el, item.value ?? '')
  }
  return { status: item.status === 'skipped' ? 'low' : item.status }
}

function report(c: Collected, status: FieldStatus, source: FillSource, extra: Partial<FieldReport> = {}): FieldReport {
  return {
    zid: c.desc.zid,
    label: (c.desc.label || c.desc.ariaLabel || c.desc.placeholder || c.desc.name || 'Unlabeled field').replace(/\s*[*✱]\s*$/, '').trim(),
    status,
    source,
    required: c.desc.required,
    missing: false,
    ...extra,
  }
}

/** Mark required fields that are still empty. */
export function refreshMissing(reports: FieldReport[], doc: Document = document): FieldReport[] {
  return reports.map((r) => {
    const t = tracked.get(r.zid)
    if (!t || !r.required) return r
    const el = findByZid(r.zid, doc)
    if (!el) return r
    return { ...r, missing: !readValue(t.c) }
  })
}

export async function fillPage(adapter: Adapter, ctx: FillContext, doc: Document = document, skip: Set<string> = new Set()): Promise<FieldReport[]> {
  const reports: FieldReport[] = []

  const repeat = adapter.fillRepeating ? await adapter.fillRepeating(ctx.profile, doc) : null
  if (repeat) reports.push(...repeat.reports)

  const all = collectFields(doc).filter((c) => !skip.has(c.desc.zid) && !repeat?.handled.has(c.desc.zid))
  const byZid = new Map(all.map((c) => [c.desc.zid, c]))
  const explicit = adapter.explicit?.(all)
  const plan = planFields(
    all.map((c) => c.desc),
    ctx.profile,
    { threshold: ctx.threshold, explicit, bank: ctx.bank, excludeKeys: repeat?.excludeKeys },
  )

  // AI field mapper for leftovers: labels and options only, never values.
  const leftovers = plan.filter((p) => p.action === 'unresolved' && byZid.get(p.zid)?.desc.kind !== 'file')
  const mappable = leftovers.filter((p) => !isQuestion(byZid.get(p.zid)!))
  if (ctx.aiReady && mappable.length) {
    const res = await send<{ mappings: { id: string; key: string }[] } | { error: string }>({
      type: 'ai:map',
      fields: mappable.map((p) => {
        const d = byZid.get(p.zid)!.desc
        return { id: p.zid, label: d.label || d.ariaLabel || d.placeholder || d.name, kind: d.kind, options: d.options }
      }),
    }).catch(() => null)
    if (res && !isError(res)) {
      const usedKeys = new Set(plan.filter((p) => p.key && p.action === 'fill').map((p) => p.key))
      for (const m of res.mappings) {
        if (m.key === 'none' || usedKeys.has(m.key as ProfileKey)) continue
        const i = plan.findIndex((p) => p.zid === m.id)
        const c = byZid.get(m.id)
        if (i < 0 || !c) continue
        plan[i] = resolveValue(c.desc, m.key as ProfileKey, ctx.profile, 0.7, 'ai-map', false)
        if (plan[i].action === 'fill') plan[i].status = 'low'
        usedKeys.add(m.key as ProfileKey)
      }
    }
  }

  let drafts = 0
  for (const item of plan) {
    const c = byZid.get(item.zid)!
    if (item.action === 'fill') {
      const r = await apply(c, item, ctx)
      tracked.set(c.desc.zid, { c, key: item.key, source: item.source })
      if (item.bankId && r.status !== 'skipped') send({ type: 'answer:used', id: item.bankId }).catch(() => undefined)
      reports.push(report(c, r.status, item.source, { key: item.key, confidence: item.confidence, reason: r.reason }))
      await humanPause()
      continue
    }

    const label = c.desc.label || c.desc.ariaLabel || c.desc.placeholder
    const canDraft =
      ctx.autoDraft && ctx.aiReady && drafts < MAX_DRAFTS_PER_PAGE && isQuestion(c) && !SENSITIVE_Q.test(label) && !readValue(c)
    if (item.action === 'unresolved' && canDraft) {
      drafts++
      const maxWords = (c.el as HTMLTextAreaElement).maxLength > 0 ? Math.max(20, Math.floor((c.el as HTMLTextAreaElement).maxLength / 7)) : c.desc.kind === 'text' ? 40 : 150
      const ai = await send<AiText | { error: string }>({ type: 'ai:answer', question: label, maxWords }).catch(() => null)
      if (ai && !isError(ai) && ai.text) {
        setText(c.el as HTMLElement, ai.text)
        tracked.set(c.desc.zid, { c, source: 'ai-draft', draft: ai.text })
        reports.push(report(c, 'draft', 'ai-draft', { reason: `Draft by ${ai.model}. Edit before you submit.`, warnings: ai.warnings }))
        continue
      }
    }
    tracked.set(c.desc.zid, { c, key: item.key, source: 'none' })
    reports.push(report(c, 'skipped', item.source, { key: item.key, reason: item.reason }))
  }

  lastReports = refreshMissing(reports, doc)
  return lastReports
}

// ---------- answer bank capture ----------

function remember(t: Tracked, source: 'typed' | 'ai') {
  const value = readValue(t.c)
  const label = t.c.desc.label || t.c.desc.ariaLabel || t.c.desc.placeholder
  if (!shouldRemember(label, t.key, value, t.c.desc.kind)) return
  send({ type: 'answer:save', label, answer: value, fieldKind: t.c.desc.kind, host: location.hostname, source }).catch(() => undefined)
}

/** Anything you answer by hand is saved with its label, so the next form fills it too. */
export function watchAnswers(doc: Document = document, onChange?: () => void) {
  const handler = (e: Event) => {
    const target = e.target as HTMLElement | null
    const zid = target?.getAttribute?.('data-zipply-id') ?? target?.getAttribute?.('data-zipply-group')
    const t = zid ? tracked.get(zid) : undefined
    if (t && !t.key) {
      const value = readValue(t.c)
      remember(t, t.draft && value === t.draft ? 'ai' : 'typed')
    }
    onChange?.()
  }
  doc.addEventListener('change', handler, true)
  // Drafts you keep as-is are saved when you submit.
  const onSubmit = () => {
    for (const t of tracked.values()) if (t.draft && readValue(t.c)) remember(t, readValue(t.c) === t.draft ? 'ai' : 'typed')
  }
  doc.addEventListener('submit', onSubmit, true)
  doc.addEventListener(
    'click',
    (e) => {
      const b = (e.target as HTMLElement | null)?.closest?.('button, input[type="submit"]')
      if (b && /submit|send application|apply/i.test((b.textContent ?? '') + ' ' + ((b as HTMLInputElement).value ?? ''))) onSubmit()
    },
    true,
  )
}

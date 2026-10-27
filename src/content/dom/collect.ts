// Read the form on the page into FieldDescriptors. Each field (or radio /
// checkbox group) is stamped with data-zipply-id so we can find it again.
import type { FieldDescriptor, FieldKind } from '@/shared/types'

export const ZID = 'data-zipply-id'
let counter = 0

export type FieldEl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLElement

export interface Collected {
  desc: FieldDescriptor
  el: FieldEl
  /** Radio buttons or checkboxes in a group (inputs, or buttons acting as them). */
  members?: HTMLElement[]
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

function textOf(el: Element | null): string {
  if (!el) return ''
  const strip = (hidden: boolean) => {
    const clone = el.cloneNode(true) as HTMLElement
    clone.querySelectorAll(`input, select, textarea, script, style, .visually-hidden-not-label${hidden ? ', [aria-hidden="true"]' : ''}`).forEach((n) => n.remove())
    return clean(clone.textContent)
  }
  // Oracle hides every word of a radio label from screen readers (the input has
  // its own name); the visible text is still the label.
  return strip(true) || strip(false)
}

/** A button that acts as a radio ("Yes" / "No" pills) or a toggle in a group. */
const BUTTON_RADIO = '[role="radio"]:not(input)'
const BUTTON_TOGGLE = '[role="list"] button[aria-pressed], [role="group"] button[aria-pressed]'

/** Checked, for inputs and for buttons acting as them. */
export function isOn(el: Element): boolean {
  if (el instanceof HTMLInputElement) return el.checked
  return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true'
}

export function isVisible(el: Element): boolean {
  const h = el as HTMLElement
  if (h.hidden || h.closest('[hidden], [aria-hidden="true"]')) return false
  const style = h.ownerDocument.defaultView?.getComputedStyle(h)
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
  // jsdom (tests) has no layout, so rects are always empty there.
  if (/jsdom/i.test(navigator.userAgent)) return true
  return h.getClientRects().length > 0
}

function byIds(doc: Document, ids: string | null): string {
  if (!ids) return ''
  return clean(
    ids
      .split(/\s+/)
      .map((id) => textOf(doc.getElementById(id)))
      .join(' '),
  )
}

/** The best human label for a control. */
export function labelFor(el: Element): string {
  const doc = el.ownerDocument
  const labelled = byIds(doc, el.getAttribute('aria-labelledby'))
  if (labelled) return labelled
  const labels = (el as HTMLInputElement).labels
  if (labels && labels.length) {
    const t = clean(Array.from(labels).map(textOf).join(' '))
    if (t) return t
  }
  const wrap = el.closest('label')
  if (wrap) {
    const t = textOf(wrap)
    if (t) return t
  }
  // Common wrappers: a field container with a label-ish child before the control.
  let node: Element | null = el.parentElement
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const lab = node.querySelector(':scope > label, :scope > legend, :scope > .label, :scope > [class*="label" i], :scope > [data-automation-id="formLabel"]')
    // Skip labels that belong to another control.
    if (lab && !lab.contains(el) && !lab.querySelector('input, select, textarea') && !(lab.getAttribute('for') && lab.getAttribute('for') !== el.id)) {
      const t = textOf(lab)
      if (t) return t
    }
    if (node.matches('fieldset, [role="group"], [role="radiogroup"], form')) break
  }
  return ''
}

/** Text shortly before the control in reading order (weak signal). */
export function nearbyText(el: Element): string {
  let node: Element | null = el
  for (let depth = 0; node && depth < 3; depth++) {
    let sib = node.previousElementSibling
    while (sib) {
      if (!sib.matches('input, select, textarea, button')) {
        const t = textOf(sib)
        if (t && t.length < 160) return t
      }
      sib = sib.previousElementSibling
    }
    node = node.parentElement
  }
  return ''
}

function groupLabel(first: HTMLElement): string {
  const group = first.closest('fieldset, [role="radiogroup"], [role="group"]')
  if (group) {
    const legend = group.querySelector('legend')
    const t = textOf(legend) || byIds(first.ownerDocument, group.getAttribute('aria-labelledby')) || clean(group.getAttribute('aria-label'))
    if (t) return t
  }
  // Fall back to the text just above the options.
  const option = first.closest('div, li, td, label') ?? first
  return nearbyText(option) || nearbyText(option.parentElement ?? option)
}

function optionLabel(input: HTMLElement): string {
  if (!(input instanceof HTMLInputElement)) return textOf(input)
  return labelFor(input) || clean(input.value)
}

function isRequired(el: Element, label: string): boolean {
  return (
    (el as HTMLInputElement).required ||
    el.getAttribute('aria-required') === 'true' ||
    /\*\s*$|\(required\)/i.test(label) ||
    // Only the field's own wrapper (two levels), not a whole form styled "required".
    // Class tokens like "required", "is-required" or "field--required" count.
    [el.parentElement, el.parentElement?.parentElement].some((n) => n && String(n.className).split(/\s+/).some((t) => /(^|[_-])required$/i.test(t)))
  )
}

function stamp(el: Element): string {
  let zid = el.getAttribute(ZID)
  if (!zid) {
    zid = `z${++counter}`
    el.setAttribute(ZID, zid)
  }
  return zid
}

function kindOf(el: Element): FieldKind | null {
  if (el instanceof HTMLTextAreaElement) return 'textarea'
  if (el instanceof HTMLSelectElement) return 'select'
  if (el instanceof HTMLInputElement) {
    const t = (el.type || 'text').toLowerCase()
    if (['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search', 'range', 'color'].includes(t)) return null
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') return 'combobox'
    if (t === 'email' || t === 'tel' || t === 'url' || t === 'number' || t === 'date' || t === 'file' || t === 'radio' || t === 'checkbox') return t as FieldKind
    if (t === 'month') return 'date'
    return 'text'
  }
  if (el.matches(BUTTON_RADIO)) return 'radio'
  if (el.matches(BUTTON_TOGGLE)) return 'checkbox'
  if (el.getAttribute('contenteditable') === 'true') return 'textarea'
  if (el.matches('button[aria-haspopup="listbox"], [role="combobox"]:not(input)')) return 'combobox'
  return null
}

function currentValue(el: Element, kind: FieldKind): string {
  if (kind === 'combobox' && !(el instanceof HTMLInputElement)) {
    const t = textOf(el)
    return /^(select|select one|choose)/i.test(t) ? '' : t
  }
  if (el instanceof HTMLSelectElement) return el.selectedIndex > 0 || el.value ? clean(el.selectedOptions[0]?.text) : ''
  if (el.getAttribute('contenteditable') === 'true') return clean(el.textContent)
  return (el as HTMLInputElement).value ?? ''
}

const SELECTOR = `input, select, textarea, [contenteditable="true"], button[aria-haspopup="listbox"], [role="combobox"]:not(input), ${BUTTON_RADIO}, ${BUTTON_TOGGLE}`

/** Collect every fillable field in `root`, grouping radios and checkboxes. */
export function collectFields(root: ParentNode = document): Collected[] {
  const out: Collected[] = []
  const radioGroups = new Map<string, HTMLElement[]>()
  const checkGroups = new Map<string, HTMLElement[]>()

  for (const el of Array.from(root.querySelectorAll(SELECTOR))) {
    const kind = kindOf(el)
    if (!kind) continue
    if ((el as HTMLInputElement).disabled) continue
    if (kind !== 'file' && !isVisible(el)) continue
    // A combobox's inner input is collected through the combobox itself.
    if (el instanceof HTMLInputElement && el.closest('[role="combobox"]:not(input)') && el.closest('[role="combobox"]') !== el) continue

    if (kind === 'radio') {
      const input = el as HTMLInputElement
      const box = input.closest('fieldset, [role="radiogroup"]')
      const key = input.name || (box && (box.getAttribute('id') || `g:${stamp(box)}`)) || `r${out.length}`
      radioGroups.set(key, [...(radioGroups.get(key) ?? []), input])
      continue
    }
    if (kind === 'checkbox') {
      const input = el as HTMLInputElement
      const group = input.closest('fieldset, [role="group"], [role="list"]')
      const key = input.name && input.name.endsWith('[]') ? input.name : group ? `g:${stamp(group)}` : ''
      if (key) {
        checkGroups.set(key, [...(checkGroups.get(key) ?? []), input])
        continue
      }
    }

    const label = labelFor(el)
    const desc: FieldDescriptor = {
      zid: stamp(el),
      kind,
      label,
      name: el.getAttribute('name') ?? el.getAttribute('data-automation-id') ?? '',
      idAttr: el.id,
      placeholder: el.getAttribute('placeholder') ?? '',
      ariaLabel: el.getAttribute('aria-label') ?? '',
      autocomplete: el.getAttribute('autocomplete') ?? '',
      nearbyText: label ? '' : nearbyText(el),
      options: el instanceof HTMLSelectElement ? Array.from(el.options).map((o) => clean(o.text)) : [],
      required: isRequired(el, label),
      value: currentValue(el, kind),
    }
    out.push({ desc, el: el as FieldEl })
  }

  for (const [, members] of radioGroups) out.push(groupField(members, 'radio'))
  for (const [, members] of checkGroups) {
    if (members.length === 1) {
      const el = members[0]
      const label = labelFor(el)
      out.push({
        desc: {
          zid: stamp(el),
          kind: 'checkbox',
          label: label || groupLabel(el),
          name: el.getAttribute('name') ?? '',
          idAttr: el.id,
          placeholder: '',
          ariaLabel: el.getAttribute('aria-label') ?? '',
          autocomplete: '',
          nearbyText: '',
          options: [],
          required: isRequired(el, label),
          value: isOn(el) ? 'Yes' : '',
        },
        el,
      })
    } else out.push(groupField(members, 'checkbox-group'))
  }
  return out
}

function groupField(members: HTMLElement[], kind: 'radio' | 'checkbox-group'): Collected {
  const first = members[0]
  const container = first.closest('fieldset, [role="radiogroup"], [role="group"], [role="list"]') ?? first.parentElement!
  const zid = stamp(container)
  members.forEach((m) => m.setAttribute('data-zipply-group', zid))
  const label = groupLabel(first)
  return {
    desc: {
      zid,
      kind,
      label,
      name: first.getAttribute('name') ?? '',
      idAttr: container.id,
      placeholder: '',
      ariaLabel: container.getAttribute('aria-label') ?? '',
      autocomplete: '',
      nearbyText: '',
      options: members.map(optionLabel),
      required: members.some((m) => (m as HTMLInputElement).required) || isRequired(container, label),
      value: members
        .filter(isOn)
        .map(optionLabel)
        .join(', '),
    },
    el: container as HTMLElement,
    members,
  }
}

export function findByZid(zid: string, root: Document = document): HTMLElement | null {
  // zids are generated (z1, z2, ...), so they need no escaping.
  return root.querySelector(`[${ZID}="${zid}"]`)
}

/** Re-read a field's current value (after filling or user edits). */
export function readValue(c: Collected): string {
  if (c.members) return c.members.filter(isOn).map(optionLabel).join(', ')
  if (c.desc.kind === 'checkbox') return isOn(c.el) ? 'Yes' : ''
  if (c.desc.kind === 'file') return (c.el as HTMLInputElement).files?.length ? (c.el as HTMLInputElement).files![0].name : ''
  return currentValue(c.el, c.desc.kind)
}

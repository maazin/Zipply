// Set values the way a person would: focus, set through the native setter,
// fire input and change, then blur. React and Angular forms register it, and
// Workday's live validation commits on blur (job_app_filler's finding).
import { pickOption } from '@/core/matching/options'
import { fromB64 } from '@/lib/crypto'
import { isOn, queryDeep } from './collect'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A short, slightly random pause between fields. */
export const humanPause = () => sleep(40 + Math.random() * 80)

function fire(el: Element, type: string, init: EventInit = { bubbles: true }) {
  const E = type === 'input' ? InputEvent : type.startsWith('key') ? KeyboardEvent : type.startsWith('mouse') || type === 'click' ? MouseEvent : type === 'focus' || type === 'blur' || type === 'focusout' || type === 'focusin' ? FocusEvent : Event
  el.dispatchEvent(new E(type, { bubbles: true, cancelable: true, composed: true, ...init }))
}

function nativeSetter(el: HTMLElement): ((v: string) => void) | null {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value')
  return desc?.set ? (v: string) => desc.set!.call(el, v) : null
}

export function commit(el: HTMLElement) {
  fire(el, 'change')
  fire(el, 'blur', { bubbles: false })
  fire(el, 'focusout')
}

export function setText(el: HTMLElement, value: string) {
  el.focus?.()
  fire(el, 'focusin')
  if (el.getAttribute('contenteditable') === 'true') {
    el.textContent = value
    fire(el, 'input')
    commit(el)
    return
  }
  const set = nativeSetter(el)
  if (set) set(value)
  else (el as HTMLInputElement).value = value
  fire(el, 'input', { bubbles: true, data: value, inputType: 'insertText' } as InputEventInit)
  commit(el)
}

export function setSelect(el: HTMLSelectElement, optionIndex: number) {
  el.focus()
  const set = nativeSetter(el)
  const value = el.options[optionIndex]?.value ?? ''
  if (set) set(value)
  el.selectedIndex = optionIndex
  fire(el, 'input')
  commit(el)
}

export function setChecked(el: HTMLElement, checked: boolean) {
  if (isOn(el) === checked) return
  // A real click toggles state and fires the events frameworks listen for.
  el.click()
  // Buttons acting as radios or toggles keep their state in aria-checked / aria-pressed.
  if (!(el instanceof HTMLInputElement)) return
  if (el.checked !== checked) {
    el.checked = checked
    fire(el, 'input')
    fire(el, 'change')
  }
}

export function setRadio(members: HTMLElement[], optionIndex: number) {
  const target = members[optionIndex]
  if (target && !isOn(target)) setChecked(target, true)
}

export function setCheckboxGroup(members: HTMLElement[], optionIndex: number) {
  const target = members[optionIndex]
  if (target && !isOn(target)) setChecked(target, true)
}

function realClick(el: HTMLElement) {
  fire(el, 'pointerdown')
  fire(el, 'mousedown')
  el.focus?.()
  fire(el, 'pointerup')
  fire(el, 'mouseup')
  el.click()
}

function visibleOptions(doc: Document, owner: HTMLElement): HTMLElement[] {
  const listId = owner.getAttribute('aria-controls') || owner.getAttribute('aria-owns')
  // The list may sit in the same component's shadow root as its input.
  const list = listId ? ((owner.getRootNode() as Document | ShadowRoot).getElementById?.(listId) ?? doc.getElementById(listId)) : null
  const scope: ParentNode = list ?? doc
  // Oracle's lists are grids: each option is a gridcell.
  return queryDeep<HTMLElement>(scope, '[role="option"], [role="gridcell"], [data-automation-id="promptOption"], .select__option, [class*="option" i][id*="option" i]').filter(
    (o) => o.getClientRects().length > 0 || /jsdom/i.test(navigator.userAgent),
  )
}

async function waitFor<T>(fn: () => T | null | undefined, timeout = 1500, step = 60): Promise<T | null> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await sleep(step)
  }
  return null
}

/**
 * Custom dropdowns (React-Select, Workday listboxes, Ashby comboboxes): open,
 * pick the closest option, and type to search only when the list hasn't got it.
 * Returns the chosen label.
 */
export async function setCombobox(el: HTMLElement, value: string, opts: { boolean?: boolean } = {}): Promise<string | null> {
  const doc = el.ownerDocument
  const input = el instanceof HTMLInputElement ? el : el.querySelector<HTMLInputElement>('input')
  const target = input ?? el
  const listed = () => {
    const o = visibleOptions(doc, target)
    return o.length ? o : null
  }
  const choose = (options: HTMLElement[]) => {
    const labels = options.map((o) => (o.textContent ?? '').replace(/\s+/g, ' ').trim())
    const pick = pickOption(labels, value, opts)
    return pick.index < 0 ? null : { el: options[pick.index], label: labels[pick.index] }
  }
  const type = (text: string) => {
    if (!input) return
    nativeSetter(input)?.(text)
    fire(input, 'input', { bubbles: true, data: text, inputType: 'insertText' } as InputEventInit)
    if (text) fire(input, 'keydown', { key: text.slice(-1) } as KeyboardEventInit)
  }

  realClick(target)
  // The whole list first. Typing the saved answer filters it, and other wording
  // ("I don't" against "I do not") then left nothing to pick.
  let choice = await waitFor(() => {
    const o = listed()
    return o && choose(o)
  }, input ? 700 : 1500)
  if (!choice && input) {
    // Lists that only show what matches your typing (schools, cities).
    type(value)
    const options = await waitFor(listed)
    choice = options && choose(options)
  }
  if (!choice) {
    // Leave nothing half-typed behind: forms flag it as an invalid entry.
    type('')
    fire(target, 'keydown', { key: 'Escape' } as KeyboardEventInit)
    return null
  }
  realClick(choice.el)
  await sleep(80)
  if (input) fire(input, 'blur', { bubbles: false })
  return choice.label
}

/** Attach a file to an <input type=file>, the way a drop would. */
export function setFile(el: HTMLInputElement, file: { name: string; mime: string; data: string }): boolean {
  try {
    const bytes = fromB64(file.data)
    const f = new File([bytes], file.name, { type: file.mime })
    const dt = new DataTransfer()
    dt.items.add(f)
    el.files = dt.files
    fire(el, 'input')
    fire(el, 'change')
    return Boolean(el.files?.length)
  } catch {
    return false
  }
}

/** Briefly outline a field after scrolling to it (the only visual we add, and it fades). */
export function flash(el: HTMLElement) {
  const target = (el.matches('input[type="file"]') && el.parentElement) || el
  target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  const prev = target.style.outline
  const prevOffset = target.style.outlineOffset
  target.style.outline = '2px solid #2563eb'
  target.style.outlineOffset = '2px'
  setTimeout(() => {
    target.style.outline = prev
    target.style.outlineOffset = prevOffset
  }, 1400)
  ;(el as HTMLInputElement).focus?.({ preventScroll: true })
}

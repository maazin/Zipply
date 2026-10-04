// Set values the way a person would: focus, set through the native setter,
// fire input and change, then blur. React and Angular forms register it, and
// Workday's live validation commits on blur (job_app_filler's finding).
import { pickOption } from '@/core/matching/options'
import { fromB64 } from '@/lib/crypto'

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

export function setChecked(el: HTMLInputElement, checked: boolean) {
  if (el.checked === checked) return
  // A real click toggles state and fires the events frameworks listen for.
  el.click()
  if (el.checked !== checked) {
    el.checked = checked
    fire(el, 'input')
    fire(el, 'change')
  }
}

export function setRadio(members: HTMLInputElement[], optionIndex: number) {
  const target = members[optionIndex]
  if (target && !target.checked) setChecked(target, true)
}

export function setCheckboxGroup(members: HTMLInputElement[], optionIndex: number) {
  const target = members[optionIndex]
  if (target && !target.checked) setChecked(target, true)
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
  const list = listId ? doc.getElementById(listId) : null
  const scope: ParentNode = list ?? doc
  return Array.from(scope.querySelectorAll<HTMLElement>('[role="option"], [data-automation-id="promptOption"], .select__option, [class*="option" i][id*="option" i]')).filter(
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
 * type to filter, then click the closest option. Returns the chosen label.
 */
export async function setCombobox(el: HTMLElement, value: string, opts: { boolean?: boolean } = {}): Promise<string | null> {
  const doc = el.ownerDocument
  const input = el instanceof HTMLInputElement ? el : el.querySelector<HTMLInputElement>('input')
  realClick(input ?? el)
  if (input) {
    const set = nativeSetter(input)
    set?.(value)
    fire(input, 'input', { bubbles: true, data: value, inputType: 'insertText' } as InputEventInit)
    fire(input, 'keydown', { key: 'a' } as KeyboardEventInit)
  }
  const options = await waitFor(() => {
    const o = visibleOptions(doc, input ?? el)
    return o.length ? o : null
  })
  if (!options) {
    fire(input ?? el, 'keydown', { key: 'Escape' } as KeyboardEventInit)
    return null
  }
  const labels = options.map((o) => (o.textContent ?? '').replace(/\s+/g, ' ').trim())
  const pick = pickOption(labels, value, opts)
  if (pick.index < 0) {
    fire(input ?? el, 'keydown', { key: 'Escape' } as KeyboardEventInit)
    return null
  }
  realClick(options[pick.index])
  await sleep(80)
  if (input) fire(input, 'blur', { bubbles: false })
  return labels[pick.index]
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

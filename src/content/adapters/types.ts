import type { AtsName, FieldReport, Posting, Profile } from '@/shared/types'
import type { ProfileKey } from '@/shared/profileKeys'
import { queryDeep, type Collected } from '../dom/collect'

export interface RepeatResult {
  reports: FieldReport[]
  /** Fields already handled, so the matcher skips them. */
  handled: Set<string>
  /** Keys the matcher shouldn't assign elsewhere on the page. */
  excludeKeys: ProfileKey[]
}

/** One module per ATS behind a shared interface: detect, fields, fill, isConfirmation. */
export interface Adapter {
  name: AtsName
  /** Hostnames this ATS serves from. Checked before any DOM detection. */
  hosts?: RegExp
  detect(url: URL, doc: Document): boolean
  /** Trusted field → profile key mappings for this ATS's known markup. */
  explicit?(fields: Collected[]): Map<string, ProfileKey>
  /** ATS-specific posting details (merged after JSON-LD). */
  posting?(doc: Document, url: URL): Promise<Partial<Posting>> | Partial<Posting>
  /** True on the "application submitted" page or message. */
  isConfirmation(doc: Document, url: URL): boolean
  /** Repeating sections such as Workday work history. */
  /** `skip`: fields already filled on an earlier pass, left as you edited them. */
  fillRepeating?(profile: Profile, doc: Document, skip?: Set<string>): Promise<RepeatResult>
}

const CONFIRM_TEXT =
  /(thank(s| you) for (applying|your application|submitting)|application (has been |was )?(successfully )?(submitted|received|completed?|sent)|(we('|’)ve|we have) (successfully )?received your application|your application is complete|successfully (submitted|applied)|you('|’)ve (successfully )?applied|submission (was )?(successful|received))/i

/** Shown on screen: not hidden by a class, a style or an attribute (always true where that can't be told). */
function shown(el: Element): boolean {
  if (el.closest('[hidden], [aria-hidden="true"]')) return false
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility
  return typeof check === 'function' ? check.call(el, { visibilityProperty: true }) : true
}

/** True when no application form is left on the page (fewer than 3 open text fields you can see). */
export function noFormLeft(doc: Document): boolean {
  const open = queryDeep<HTMLInputElement>(doc, 'input[type="text"], input[type="email"], input[type="tel"], input:not([type]), textarea').filter(
    (i) => !i.disabled && shown(i),
  )
  return open.length < 3
}

/** Visible confirmation wording in a heading, alert or message, with no form left to fill. */
export function genericConfirmation(doc: Document): boolean {
  const nodes = queryDeep(doc, 'h1, h2, h3, h4, [role="alert"], [role="status"], [aria-live], [class*="confirm" i], [class*="success" i], [class*="thank" i], [class*="submitted" i]')
  return nodes.some((n) => CONFIRM_TEXT.test(n.textContent ?? '') && shown(n)) && noFormLeft(doc)
}

/** An ATS-specific success marker, trusted only once the form itself is gone. */
export function markerConfirmation(doc: Document, selector: string): boolean {
  return Boolean(doc.querySelector(selector)) && noFormLeft(doc)
}

/** Build an explicit map from attribute patterns. */
export function mapBy(fields: Collected[], rules: [RegExp, ProfileKey][], attr: (c: Collected) => string): Map<string, ProfileKey> {
  const m = new Map<string, ProfileKey>()
  const used = new Set<ProfileKey>()
  for (const c of fields) {
    const a = attr(c)
    if (!a) continue
    for (const [re, key] of rules) {
      if (re.test(a) && !used.has(key)) {
        m.set(c.desc.zid, key)
        used.add(key)
        break
      }
    }
  }
  return m
}

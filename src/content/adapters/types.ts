import type { AtsName, FieldReport, Posting, Profile } from '@/shared/types'
import type { ProfileKey } from '@/shared/profileKeys'
import type { Collected } from '../dom/collect'

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
  fillRepeating?(profile: Profile, doc: Document): Promise<RepeatResult>
}

const CONFIRM_TEXT =
  /(thank you for (applying|your application|submitting)|thanks for applying|application (has been |was )?(successfully )?(submitted|received|complete)|we('|’)ve received your application|your application is complete|successfully submitted)/i

/** Visible confirmation wording in a heading or alert, with no form left to fill. */
export function genericConfirmation(doc: Document): boolean {
  const nodes = Array.from(doc.querySelectorAll('h1, h2, h3, [role="alert"], [role="status"], [class*="confirm" i], [class*="success" i], [class*="thank" i]'))
  const hit = nodes.some((n) => CONFIRM_TEXT.test(n.textContent ?? ''))
  if (!hit) return false
  const openInputs = doc.querySelectorAll('form input[type="text"]:not([disabled]), form input[type="email"]:not([disabled]), form textarea:not([disabled])').length
  return openInputs < 3
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

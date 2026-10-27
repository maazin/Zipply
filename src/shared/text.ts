// Text helpers shared by the matcher, the checks and Gmail sync.

/** Abbreviations seen in field names and ids (idea from FormFilla's dictionary). */
const ABBREVIATIONS: Record<string, string> = {
  fname: 'first name',
  firstname: 'first name',
  givenname: 'given name',
  lname: 'last name',
  lastname: 'last name',
  surname: 'surname',
  familyname: 'family name',
  fullname: 'full name',
  mname: 'middle name',
  tel: 'phone',
  telephone: 'phone',
  phonenumber: 'phone number',
  mobilephone: 'mobile phone',
  cellphone: 'cell phone',
  addr: 'address',
  addr1: 'address line 1',
  address1: 'address line 1',
  addressline1: 'address line 1',
  zip: 'zip',
  zipcode: 'zip code',
  postalcode: 'postal code',
  postcode: 'postal code',
  org: 'organization',
  dob: 'date of birth',
  li: 'linkedin',
  gh: 'github',
  url: 'url',
  emailaddress: 'email address',
  yoe: 'years of experience',
  edu: 'education',
  eeo: 'eeo',
}

/** Split camelCase, snake_case, kebab-case and bracketed names into words. */
export function splitIdentifier(s: string): string {
  return s
    .replace(/\[|\]|\./g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-:]+/g, ' ')
}

/** Lowercase, drop required markers and punctuation, expand abbreviations. */
export function normalizeLabel(s: string): string {
  const base = s
    .replace(/\*/g, ' ')
    .replace(/\((required|optional)\)/gi, ' ')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9+#/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return base
    .split(' ')
    .map((w) => ABBREVIATIONS[w] ?? w)
    .join(' ')
    .replace(/\b(required|optional)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeIdentifier(s: string): string {
  return normalizeLabel(splitIdentifier(s))
}

const STOP = new Set([
  'a', 'an', 'the', 'of', 'to', 'for', 'and', 'or', 'your', 'you', 'are', 'is', 'do', 'please', 'enter', 'in',
  'on', 'at', 'this', 'with', 'what', 'our', 'any', 'if', 'be', 'by', 'as', 'we', 'us', 'it', 'have', 'will',
])

export function tokens(s: string): string[] {
  return normalizeLabel(s)
    .split(' ')
    .filter((t) => t && !STOP.has(t))
}

/** Token-set Jaccard similarity, 0..1. */
export function jaccard(a: string, b: string): number {
  const A = new Set(tokens(a))
  const B = new Set(tokens(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/** Dice coefficient over character bigrams, 0..1. Good for near-identical titles. */
export function bigramSimilarity(a: string, b: string): number {
  const x = normalizeLabel(a).replace(/ /g, '')
  const y = normalizeLabel(b).replace(/ /g, '')
  if (!x || !y) return 0
  if (x === y) return 1
  const grams = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const gx = grams(x)
  const gy = grams(y)
  let inter = 0
  for (const [g, n] of gx) inter += Math.min(n, gy.get(g) ?? 0)
  return (2 * inter) / (x.length - 1 + (y.length - 1))
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whole-word match. Ported from Resume-Matcher's `_keyword_in_text` and
 * Auto_job_applier_linkedIn's `find_bad_word`: boundaries are applied only on the
 * alphanumeric edges of the phrase, so "Java" never matches inside "JavaScript"
 * while "C++" and ".NET" still match.
 */
export function keywordInText(keyword: string, text: string): boolean {
  const kw = keyword.trim()
  if (!kw) return false
  const left = /^[\p{L}\p{N}_]/u.test(kw) ? '(?<![\\p{L}\\p{N}_])' : ''
  const right = /[\p{L}\p{N}_]$/u.test(kw) ? '(?![\\p{L}\\p{N}_])' : ''
  return new RegExp(left + escapeRegExp(kw) + right, 'iu').test(text)
}

/** First entry of `words` found as a whole word in `text`, else null. */
export function findBadWord(text: string, words: string[]): string | null {
  for (const w of words) if (w.trim() && keywordInText(w, text)) return w.trim()
  return null
}

const COMPANY_SUFFIXES = [
  'incorporated', 'inc', 'llc', 'l l c', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh',
  'ag', 'sa', 'a/s', 'group', 'holdings', 'lp', 'llp', 'pllc',
  // Other legal forms, and words job sites add to a company's name ("Infor Careers").
  'aps', 'ab', 'as', 'bv', 'nv', 'oy', 'srl', 'sas', 'sarl', 'pty', 'pvt', 'kg', 'se',
  'careers', 'jobs', 'recruiting', 'recruitment', 'hiring', 'talent',
]

/** "Acme, Inc." and "ACME Corp" both become "acme". */
export function normalizeCompany(s: string): string {
  let out = s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  let changed = true
  while (changed) {
    changed = false
    for (const suf of COMPANY_SUFFIXES) {
      if (out.endsWith(' ' + suf)) {
        out = out.slice(0, -suf.length - 1).trim()
        changed = true
      }
    }
  }
  return out.replace(/^the /, '')
}

export function wordCount(s: string): number {
  return (s.match(/\S+/g) ?? []).length
}

/**
 * A date cell from the sheet as YYYY-MM-DD. Sheets can hand back a serial
 * number (46317) when the cell isn't formatted as a date, or a locale date
 * (10/22/2026). Anything else is returned unchanged.
 */
export function toISODate(v: string): string {
  const s = v.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  if (/^\d{4,6}(\.\d+)?$/.test(s)) {
    // Days since 1899-12-30, Sheets' (and Excel's) day zero.
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000)
    return d.toISOString().slice(0, 10)
  }
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
  return s
}

export function todayISO(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function daysBetween(fromISO: string, to: Date = new Date()): number {
  const from = new Date(fromISO)
  if (Number.isNaN(from.getTime())) return NaN
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000)
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/**
 * Career-site names stand in for the employer in many postings: "Acme
 * Candidate Experience page", "Careers at Acme", "Acme Careers". Keep the
 * company part; anything else is returned unchanged.
 */
export function companyFromSiteName(name: string): string {
  const out = name
    .trim()
    .replace(/^(careers?|jobs?|work|join us)\s+(at|with)\s+/i, '')
    .replace(/\s*[-|–:]?\s*(external\s+)?(candidate experience|careers? (site|page|portal|center|centre|hub)|job (site|board|portal)|careers?|jobs|talent community)(\s+(page|site|portal))?$/i, '')
    .trim()
  return out || name.trim()
}

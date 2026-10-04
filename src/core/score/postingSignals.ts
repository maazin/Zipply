/*
 * Posting signal extraction. Years-of-experience pattern and whole-word filters
 * ported from Auto_job_applier_linkedIn (https://github.com/GodsScion/Auto_job_applier_linkedIn)
 * runAiBot.py (re_experience, extract_years_of_experience, clearance_terms), MIT.
 * Modified: translated to TypeScript; sponsorship phrases are our own lists.
 */
import type { SalaryRange, WorkMode } from '@/shared/types'
import { findBadWord } from '@/shared/text'

// Same pattern as Auto_job_applier_linkedIn's re_experience.
const RE_EXPERIENCE = /[(]?\s*(\d+)\s*[)]?\s*[-to]*\s*\d*[+]*\s*years?/gi

/** Years of experience asked for. Max of all mentions up to 12 (larger numbers are rarely YOE). */
export function yearsRequired(text: string): number | null {
  const nums: number[] = []
  for (const m of text.matchAll(RE_EXPERIENCE)) {
    const n = Number(m[1])
    // Skip "the last 3 years", "a 4-year degree" style mentions.
    const at = m.index ?? 0
    const ctx = text.slice(Math.max(0, at - 10), at + m[0].length + 12).toLowerCase()
    if (/year degree|years? old|last \d+ years|past \d+ years|years? (in business|of history|ago)/.test(ctx)) continue
    if (n <= 12) nums.push(n)
  }
  return nums.length ? Math.max(...nums) : null
}

export const SENIOR_TITLE = /\b(senior|sr\.?|staff|principal|lead|head of|director|manager ii|architect)\b/i

export const CLEARANCE_TERMS = ['polygraph', 'clearance', 'top secret', 'ts/sci', 'secret clearance', 'security clearance']

export const SPONSORSHIP_OFFERED = [
  'will sponsor',
  'sponsorship available',
  'sponsorship is available',
  'visa sponsorship available',
  'we sponsor',
  'able to sponsor',
  'h-1b transfer',
  'h1b transfer',
  'sponsorship provided',
  'open to sponsoring',
]

export const SPONSORSHIP_UNAVAILABLE = [
  'no sponsorship',
  'not sponsor',
  'unable to sponsor',
  'cannot sponsor',
  'can not sponsor',
  'will not sponsor',
  "won't sponsor",
  'not able to sponsor',
  'does not sponsor',
  'do not sponsor',
  'not provide sponsorship',
  'not offer sponsorship',
  'without sponsorship',
  'sponsorship is not available',
  'sponsorship not available',
  'must be authorized to work in the united states without',
  'not eligible for sponsorship',
  'us citizens only',
  'u.s. citizens only',
  'must be a us citizen',
  'must be a u.s. citizen',
  'green card holders',
]

export type SponsorshipStance = 'offered' | 'refused' | 'silent'

/** Offers win: real postings say both ("we don't require ... we will sponsor transfers"). */
export function sponsorshipStance(text: string): { stance: SponsorshipStance; phrase: string } {
  const offer = findBadWord(text, SPONSORSHIP_OFFERED)
  if (offer) return { stance: 'offered', phrase: offer }
  const refuse = findBadWord(text, SPONSORSHIP_UNAVAILABLE)
  if (refuse) return { stance: 'refused', phrase: refuse }
  return { stance: 'silent', phrase: '' }
}

export const CONTRACT_TERMS = ['1099', 'c2c', 'corp to corp', 'corp-to-corp', 'contract to hire', 'contract-to-hire', 'w2 contract', 'contractor position', 'freelance']

export function workModeOf(text: string): WorkMode | '' {
  const t = text.toLowerCase()
  if (/\bhybrid\b/.test(t)) return 'hybrid'
  if (/\b(fully remote|100% remote|remote[- ]first|remote position|remote role|work from home|wfh)\b/.test(t) || /^remote\b/.test(t)) return 'remote'
  if (/\b(on[- ]?site|in[- ]office|in person)\b/.test(t)) return 'onsite'
  if (/\bremote\b/.test(t)) return 'remote'
  return ''
}

function toNumber(s: string, k: string | undefined): number {
  const n = Number(s.replace(/,/g, ''))
  return k && /k/i.test(k) ? n * 1000 : n
}

/** Find a salary range like "$60,000 - $120,000" or "$45/hr to $55/hr". */
export function parseSalary(text: string): SalaryRange | null {
  const re = /([$£€])\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([kK])?\s*(?:\/\s?(hour|hr|year|yr|annum|month|mo))?\s*(?:-|–|—|to)\s*[$£€]?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([kK])?\s*(?:(?:\/|per|an|a)\s?(hour|hr|year|yr|annum|annually|month|mo))?/
  const m = text.match(re)
  if (!m) return null
  const min = toNumber(m[2], m[3])
  const max = toNumber(m[5], m[6] ?? m[3])
  if (!min || !max || max < min) return null
  const unit = (m[7] ?? m[4] ?? '').toLowerCase()
  const period: SalaryRange['period'] = /hour|hr/.test(unit)
    ? 'hour'
    : /month|mo/.test(unit)
      ? 'month'
      : /year|yr|annum|annual/.test(unit) || min > 1000
        ? 'year'
        : 'unknown'
  const currency = m[1] === '£' ? 'GBP' : m[1] === '€' ? 'EUR' : 'USD'
  return { min, max, currency, period }
}

/** Annualize a range for comparing against an annual minimum. */
export function annualize(r: SalaryRange): { min: number; max: number } | null {
  const f = r.period === 'year' ? 1 : r.period === 'month' ? 12 : r.period === 'hour' ? 2080 : 0
  return f ? { min: r.min * f, max: r.max * f } : null
}

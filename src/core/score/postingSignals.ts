/*
 * Posting signal extraction. Years-of-experience pattern and whole-word filters
 * ported from Auto_job_applier_linkedIn (https://github.com/GodsScion/Auto_job_applier_linkedIn)
 * runAiBot.py (re_experience, extract_years_of_experience, clearance_terms), MIT.
 * Modified: translated to TypeScript; sponsorship phrases are our own lists.
 */
import type { SalaryRange, WorkMode } from '@/shared/types'
import { findBadWord } from '@/shared/text'

const WORD_NUM: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const N = String.raw`(\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten)`
/**
 * "3 years", "3+ years", "(3) years", "3-5 years", "0–2 years", "1 to 3 years",
 * "three years". Started from Auto_job_applier_linkedIn's re_experience, which
 * missed en dashes and words, so "0–2 years" used to read as 2.
 */
const RE_EXPERIENCE = new RegExp(String.raw`\(?\s*${N}\s*\)?\s*(\+)?\s*(?:(?:-|–|—|to)\s*\(?\s*${N}\s*\)?\s*\+?\s*)?\+?\s*years?\b`, 'gi')
/** Mentions of years that aren't experience. */
const NOT_EXPERIENCE = /year degree|years? old|years? of age|(last|past|next|within|every|first) \d+(\+)? years|years? (in business|of history|ago|contract|commitment|term|program|warranty)/
/** Wording that makes it nice to have rather than required. */
const PREFERRED = /\b(prefer(?:red|ably|ence)?|ideal(?:ly)?|nice[- ]to[- ]have|a plus|bonus|desired|desirable|advantage(?:ous)?)\b/i
/** A heading line like "Preferred qualifications" or "Nice to have". */
const HEADING = /^[\s#*•·-]*[a-z][a-z &/'’()-]{2,60}:?\s*$/i

const num = (s: string | undefined) => (s == null ? null : (WORD_NUM[s.toLowerCase()] ?? Number(s)))

export interface ExperienceAsk {
  /** The fewest years that meet it: "3-5 years" is 3, "0-2 years" is 0. */
  min: number
  /** The top of a range, or null for "3+ years". */
  max: number | null
  /** Only preferred ("ideally 5 years", or under "Preferred qualifications"). */
  preferred: boolean
}

/**
 * Years of experience the posting asks for. A range counts from its low end.
 * When several are required, the highest minimum wins ("1+ years of SQL, 3+
 * years of Python" asks for 3). Preferred years count only when nothing is
 * required. Numbers above 12 are rarely experience and are skipped.
 */
export function experienceAsk(text: string): ExperienceAsk | null {
  const required: ExperienceAsk[] = []
  const preferred: ExperienceAsk[] = []
  let inPreferred = false
  for (const line of text.split(/\n+/)) {
    if (HEADING.test(line) && !/\d|\byears?\b/i.test(line)) {
      inPreferred = PREFERRED.test(line) || /\bnice\b|\bplus\b|\bbonus\b/i.test(line)
      continue
    }
    for (const sentence of line.split(/(?<=[.;!?])\s+/)) {
      for (const m of sentence.matchAll(RE_EXPERIENCE)) {
        const at = m.index ?? 0
        const ctx = sentence.slice(Math.max(0, at - 10), at + m[0].length + 14).toLowerCase()
        if (NOT_EXPERIENCE.test(ctx)) continue
        const lo = num(m[1])!
        const hi = num(m[3])
        if (lo > 12 || (hi != null && hi > 15)) continue
        const ask: ExperienceAsk = { min: hi != null ? Math.min(lo, hi) : lo, max: hi != null ? Math.max(lo, hi) : null, preferred: false }
        if (inPreferred || PREFERRED.test(sentence)) preferred.push({ ...ask, preferred: true })
        else required.push(ask)
      }
    }
  }
  const pool = required.length ? required : preferred
  if (!pool.length) return null
  return pool.reduce((best, a) => (a.min > best.min ? a : best))
}

/** Years of experience asked for: the low end of what's required, or null. */
export function yearsRequired(text: string): number | null {
  return experienceAsk(text)?.min ?? null
}

/** "0–2 years" or "3+ years". */
export function describeAsk(a: ExperienceAsk): string {
  return a.max != null ? `${a.min}–${a.max} years` : `${a.min}+ years`
}

export const SENIOR_TITLE = /\b(senior|sr\.?|staff|principal|lead|head of|director|manager ii|architect)\b/i

/** A government clearance, not "background check clearance" or "medical clearance". */
const CLEARANCE = /\b(polygraph|top[ -]secret|ts\s*\/\s*sci|(?:security|secret|government|federal|dod|doe|active|public trust)\s+clearance|clearance\s*(?:level)?\s*[:(-]\s*(?:secret|top secret|ts|public trust))\b/i
/** "No clearance required", "does not require a security clearance". */
const NOT_NEEDED = new RegExp(
  [
    // "no security clearance", "without a clearance"
    String.raw`\b(?:no|not|without)\s+(?:an?\s+)?(?:[\w/-]+\s+){0,3}(?:clearance|polygraph)`,
    // "clearance is not required", "clearance: not needed"
    String.raw`(?:clearance|polygraph)[^.]{0,30}\b(?:not|isn['’]t|n['’]t)\s+(?:\w+\s+)?(?:required|needed|necessary)`,
    // "does not require a security clearance", "doesn't need a clearance"
    String.raw`\b(?:not|n['’]t)\s+(?:require|need)\b[^.]{0,40}(?:clearance|polygraph)`,
  ].join('|'),
  'i',
)
/** "Able to obtain", "eligible for": you'd get one through the job, not bring one. */
const CAN_OBTAIN = /\b(obtain|eligib\w*|able to (?:get|acquire|receive)|willing(?:ness)? to (?:obtain|undergo|apply)|sponsor\w*\s+(?:\w+\s+){0,2}clearance|clearance sponsorship)\b/i

/** Wording that makes it a requirement: "required", "must hold", "active", "current". */
const REQUIRED = /\b(required|requires?|requirement|must|mandatory|need(?:ed|s)?|active|current(?:ly)?|hold(?:s|ing)?|possess(?:es|ing)?|maintain(?:s|ing)?|cleared|only)\b|^\s*(?:security\s+)?clearance(?:\s+level)?\s*:/i
/** Only nice to have, or only sometimes: "preferred", "a plus", "may require", "if applicable". */
const SOFT = /\b(prefer(?:red|ably|ence)?|plus|bonus|nice[- ]to[- ]have|desired|desirable|advantage(?:ous)?|ideal(?:ly)?|may|might|could|some (?:positions|roles|projects)|if (?:applicable|required|needed)|where (?:applicable|required)|as needed)\b/i

/**
 * The sentence asking you to already hold a clearance, or null. It has to name
 * a government clearance and say it's required, and not that it's only
 * preferred, sometimes needed, not needed, or something you'd get on the job.
 */
export function clearanceAsk(description: string): string | null {
  for (const raw of description.split(/(?<=[.!?;])\s+|\n+/)) {
    const sentence = raw.replace(/^[\s•*·-]+/, '').trim()
    if (!CLEARANCE.test(sentence) || NOT_NEEDED.test(sentence) || CAN_OBTAIN.test(sentence) || SOFT.test(sentence)) continue
    // A bullet under "Requirements" may just say "Active Secret clearance".
    if (REQUIRED.test(sentence) || sentence.split(/\s+/).length <= 6) return sentence.length > 140 ? `${sentence.slice(0, 137)}...` : sentence
  }
  return null
}

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

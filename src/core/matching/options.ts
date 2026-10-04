import { normalizeLabel, tokens, bigramSimilarity } from '@/shared/text'

/** Phrases that mean "I'd rather not say" on EEO questions. */
export const DECLINE_PHRASES = [
  'decline',
  'prefer not',
  'not wish',
  'dont wish',
  'do not wish',
  'not want',
  'rather not',
  'choose not',
  'not to disclose',
  'not to answer',
  'not to self identify',
  'not to identify',
]

const EQUIVALENTS: string[][] = [
  ['united states', 'united states of america', 'usa', 'us', 'u s', 'america'],
  ['united kingdom', 'uk', 'great britain', 'england'],
  ['bachelors', 'bachelor', 'bachelors degree', 'bachelor of science', 'bachelor of arts', 'bs', 'ba', 'bsc', 'b s', 'b a', 'undergraduate'],
  ['masters', 'master', 'masters degree', 'master of science', 'master of arts', 'ms', 'ma', 'msc', 'mba'],
  ['phd', 'doctorate', 'doctoral', 'doctor of philosophy'],
  ['associates', 'associate', 'associates degree', 'associate degree'],
  ['high school', 'high school diploma', 'ged', 'secondary'],
  ['male', 'man'],
  ['female', 'woman'],
  ['non binary', 'nonbinary', 'non-binary', 'genderqueer'],
  ['linkedin', 'linked in'],
  ['company website', 'careers page', 'company career site', 'career site', 'website'],
  ['referral', 'employee referral', 'referred by an employee'],
  ['job board', 'indeed', 'glassdoor', 'online job board'],
]

const YES = /^(yes|y|true|i am|i do|i have|i will|i would|i can|authorized|willing)\b/
const NO = /^(no|n|false|i am not|i do not|i dont|i have not|i will not|i wont|not)\b/

export function isDecline(s: string): boolean {
  const n = normalizeLabel(s).replace(/[^a-z ]/g, '')
  return DECLINE_PHRASES.some((p) => n.includes(p))
}

function canonical(s: string): string {
  const n = normalizeLabel(s).replace(/[^a-z0-9 ]/g, '').trim()
  for (const group of EQUIVALENTS) if (group.includes(n)) return group[0]
  return n
}

/** Polarity of an option or answer: 1 yes, -1 no, 0 neither. */
export function polarity(s: string): number {
  const n = normalizeLabel(s)
  if (NO.test(n)) return -1
  if (YES.test(n)) return 1
  return 0
}

/**
 * Pick the option that best represents `value`. Returns the option index and a
 * 0..1 confidence, or -1 when nothing is close enough.
 */
export function pickOption(options: string[], value: string, opts: { boolean?: boolean } = {}): { index: number; confidence: number } {
  const clean = options.map((o) => o.trim())
  const real = clean.map((o, i) => ({ o, i })).filter(({ o }) => o && !/^(select|choose|please select|--|—|none selected)/i.test(o))
  if (!value.trim() || !real.length) return { index: -1, confidence: 0 }

  if (isDecline(value)) {
    const hit = real.find(({ o }) => isDecline(o))
    return hit ? { index: hit.i, confidence: 0.95 } : { index: -1, confidence: 0 }
  }

  if (opts.boolean) {
    const want = polarity(value)
    if (want) {
      const hits = real.filter(({ o }) => polarity(o) === want)
      if (hits.length) {
        // Prefer the shortest ("Yes" over "Yes, I will require sponsorship in the future").
        hits.sort((a, b) => a.o.length - b.o.length)
        return { index: hits[0].i, confidence: 0.92 }
      }
    }
  }

  const cv = canonical(value)
  let best = { index: -1, confidence: 0 }
  for (const { o, i } of real) {
    const co = canonical(o)
    let s = 0
    if (co === cv) s = 1
    else if (co.startsWith(cv + ' ') || cv.startsWith(co + ' ')) s = 0.85
    else {
      const vt = new Set(tokens(cv))
      const ot = tokens(co)
      const inter = ot.filter((t) => vt.has(t)).length
      const tokenScore = vt.size && ot.length ? inter / Math.max(vt.size, ot.length) : 0
      s = Math.max(tokenScore * 0.9, bigramSimilarity(co, cv) * 0.85)
    }
    if (s > best.confidence) best = { index: i, confidence: s }
  }
  return best.confidence >= 0.6 ? best : { index: -1, confidence: best.confidence }
}

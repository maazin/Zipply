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

/** "dont" → "do not", so "I don't have" and "I do not have" read the same. */
const CONTRACTIONS: [RegExp, string][] = [
  [/\b(do|does|did|is|are|was|were|have|has|had|would|should|could)nt\b/g, '$1 not'],
  [/\bwont\b/g, 'will not'],
  [/\bcant\b/g, 'can not'],
  [/\bcannot\b/g, 'can not'],
  [/\bim\b/g, 'i am'],
  [/\bive\b/g, 'i have'],
]
function expand(n: string): string {
  return CONTRACTIONS.reduce((s, [re, to]) => s.replace(re, to), n)
}

/** Says "not": "I am not a protected veteran", "Not Hispanic", "No, I don't". Not "Asian (Not Hispanic or Latino)". */
const NEGATED = /\b(not|no|non|never|none|neither)\b/
const negated = (s: string) => NEGATED.test(expand(normalizeLabel(s.replace(/\([^)]*\)/g, ' '))))
const FILLER = new Set(['i', 'am', 'a', 'an', 'the', 'of', 'or', 'and', 'to', 'as', 'have', 'has', 'do', 'not', 'no', 'non', 'yes', 'one', 'more'])

export function isDecline(s: string): boolean {
  const n = normalizeLabel(s).replace(/[^a-z ]/g, '')
  return DECLINE_PHRASES.some((p) => n.includes(p))
}

function canonical(s: string): string {
  const n = expand(normalizeLabel(s).replace(/[^a-z0-9 ]/g, '').trim())
  for (const group of EQUIVALENTS) if (group.includes(n)) return group[0]
  return n
}

/** Polarity of an option or answer: 1 yes, -1 no, 0 neither. */
export function polarity(s: string): number {
  const n = expand(normalizeLabel(s))
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
  const listed = clean.map((o, i) => ({ o, i })).filter(({ o }) => o && !/^(select|choose|please select|--|—|none selected)/i.test(o))
  if (!value.trim() || !listed.length) return { index: -1, confidence: 0 }

  if (isDecline(value)) {
    const hit = listed.find(({ o }) => isDecline(o))
    return hit ? { index: hit.i, confidence: 0.95 } : { index: -1, confidence: 0 }
  }
  // An answer isn't "I don't wish to answer", though it may start with "I don't".
  const real = listed.filter(({ o }) => !isDecline(o))
  if (!real.length) return { index: -1, confidence: 0 }

  const cv = canonical(value)
  const similarity = (o: string): number => {
    const co = canonical(o)
    if (co === cv) return 1
    let s: number
    if (co.startsWith(cv + ' ') || cv.startsWith(co + ' ')) s = 0.85
    else {
      const vt = new Set(tokens(cv))
      const ot = tokens(co)
      const inter = ot.filter((t) => vt.has(t)).length
      const tokenScore = vt.size && ot.length ? inter / Math.max(vt.size, ot.length) : 0
      s = Math.max(tokenScore * 0.9, bigramSimilarity(co, cv) * 0.85)
    }
    // "I am not a protected veteran" isn't "Protected Veteran".
    return negated(o) === negated(value) ? s : s * 0.5
  }

  // Yes/no questions, and a bare "Yes" or "No" anywhere ("No" → "Not Hispanic or Latino").
  const want = polarity(value)
  if (want && (opts.boolean || cv.split(' ').length <= 2)) {
    const hits = real.filter(({ o }) => polarity(o) === want)
    if (hits.length) {
      // The closest wording; then the shortest ("Yes" over "Yes, I will require sponsorship in the future").
      const best = hits.map((h) => ({ ...h, s: similarity(h.o) })).sort((a, b) => b.s - a.s || a.o.length - b.o.length)[0]
      return { index: best.i, confidence: Math.max(0.92, best.s) }
    }
  }

  let best = { index: -1, confidence: 0 }
  for (const { o, i } of real) {
    const s = similarity(o)
    if (s > best.confidence) best = { index: i, confidence: s }
  }
  if (best.confidence >= 0.6) return best
  // "I am not a protected veteran" → "Not a Veteran": the only "not" option, about the same thing.
  if (negated(value)) {
    const words = new Set(tokens(cv).filter((t) => !FILLER.has(t)))
    const nots = real.filter(({ o }) => negated(o))
    if (nots.length === 1 && tokens(canonical(nots[0].o)).some((t) => words.has(t))) return { index: nots[0].i, confidence: 0.8 }
  }
  return { index: -1, confidence: best.confidence }
}

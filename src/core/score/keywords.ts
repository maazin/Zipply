import { escapeRegExp, keywordInText } from '@/shared/text'
import { CASE_SENSITIVE, SKILLS, SOFT_WEIGHT, type SkillDef } from './skills'

export type KeywordTier = 'required' | 'preferred' | 'other'

export interface Keyword {
  term: string
  tier: KeywordTier
  tech: boolean
  /** Ranking weight: tier x frequency x specificity (a TF-IDF-style score). */
  weight: number
}

const REQUIRED_HEAD = /^(requirements?|required|must[- ]haves?|minimum qualifications?|basic qualifications?|what you('|’)?ll need|what we('|’)?re looking for|you have|qualifications|who you are|about you|skills( and| &) experience)\b/i
const PREFERRED_HEAD = /^(preferred|nice[- ]to[- ]haves?|bonus|pluses|plus|preferred qualifications?|additional qualifications?|it('|’)?s a plus|extra credit|good to have)\b/i
const OTHER_HEAD = /^(responsibilities|what you('|’)?ll do|the role|about the role|role overview|day to day|your impact|about the (job|position|opportunity))\b/i
// About the employer, not the job: its products and perks aren't skills you need.
const IGNORE_HEAD = /^(about (us|the company|the team|[A-Z][\w&.' -]{1,40})|who we are|our (company|mission|story|values|culture|team)|benefits|perks|what we offer|compensation|pay (range|transparency)|salary|equal (employment )?opportunity|eeo|diversity|accommodations?|why (join|work)|life at|privacy|disclaimer|how to apply|application process)\b/i
// Legal and recruiting boilerplate that can sit anywhere.
const BOILERPLATE = /equal opportunity employer|without regard to|regardless of (race|age|gender)|reasonable accommodation|e-?verify|privacy (policy|notice)|applicants? (with|who require)|protected (veteran|status|characteristic)/i

/**
 * Split a posting into required / preferred / other text by its headings.
 * Sections about the employer (About us, Benefits, EEO) are left out.
 */
export function splitPosting(text: string): Record<KeywordTier, string> {
  const out: Record<KeywordTier, string[]> = { required: [], preferred: [], other: [] }
  let tier: KeywordTier | 'ignore' = 'other'
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim()
    if (!line) continue
    const head = line.replace(/^[#*\-•\s]+/, '').replace(/[:：]\s*$/, '')
    const isHeading = head.length < 70 && (/[:：]$/.test(line) || !/[.!?]$/.test(line))
    if (isHeading && PREFERRED_HEAD.test(head)) {
      tier = 'preferred'
      continue
    }
    if (isHeading && REQUIRED_HEAD.test(head)) {
      tier = 'required'
      continue
    }
    if (isHeading && OTHER_HEAD.test(head)) {
      tier = 'other'
      continue
    }
    if (isHeading && IGNORE_HEAD.test(head)) {
      tier = 'ignore'
      continue
    }
    if (tier === 'ignore' || BOILERPLATE.test(line)) continue
    // Inline cues inside a bullet override the section.
    let lineTier: KeywordTier = tier
    if (/\b(preferred|nice to have|a plus|is a plus|bonus)\b/i.test(line)) lineTier = 'preferred'
    else if (/\b(required|must have|must be|minimum of)\b/i.test(line)) lineTier = 'required'
    out[lineTier].push(line)
  }
  return { required: out.required.join('\n'), preferred: out.preferred.join('\n'), other: out.other.join('\n') }
}

function variants(s: SkillDef): string[] {
  return [s.term, ...s.synonyms]
}

/** "retrieval-augmented generation" and "Retrieval augmented generation" are the same term. */
function flexible(variant: string): string {
  return escapeRegExp(variant)
    .split(/[\s-]+/)
    .join('[\\s-]+')
}

function countIn(variant: string, text: string): number {
  const cs = CASE_SENSITIVE.has(variant)
  // Single letters ("C", "R") also refuse "C-suite", "R&D", "C/C++" and "D.C.".
  const single = variant.length === 1
  const left = /^[\p{L}\p{N}_]/u.test(variant) ? (single ? '(?<![\\p{L}\\p{N}_.])' : '(?<![\\p{L}\\p{N}_])') : ''
  const tail = single ? '(?![\\p{L}\\p{N}_+#&/\\-])' : '(?![\\p{L}\\p{N}_+#])'
  const right = /[\p{L}\p{N}_]$/u.test(variant) ? tail : ''
  const re = new RegExp(left + flexible(variant) + right, cs ? 'gu' : 'giu')
  return (text.match(re) ?? []).length
}

/** True when the skill (or any synonym) appears as a whole word. */
export function hasSkill(skill: SkillDef | string, text: string): boolean {
  const def = typeof skill === 'string' ? SKILLS.find((s) => s.term === skill) : skill
  if (!def) return keywordInText(skill as string, text)
  return variants(def).some((v) => countIn(v, text) > 0)
}

const TIER_WEIGHT: Record<KeywordTier, number> = { required: 2, preferred: 1, other: 1 }

/** Dictionary terms found in the posting, ranked. */
export function extractKeywords(posting: string): Keyword[] {
  const parts = splitPosting(posting)
  const found = new Map<string, Keyword>()
  for (const s of SKILLS) {
    if (!s.tech && s.weight < SOFT_WEIGHT) continue
    let tier: KeywordTier | null = null
    let freq = 0
    for (const t of ['required', 'preferred', 'other'] as KeywordTier[]) {
      const n = variants(s).reduce((sum, v) => sum + countIn(v, parts[t]), 0)
      if (n && !tier) tier = t
      freq += n
    }
    if (!tier) continue
    found.set(s.term, {
      term: s.term,
      tier,
      tech: s.tech,
      weight: TIER_WEIGHT[tier] * s.weight * (1 + Math.log(freq)),
    })
  }
  return [...found.values()].sort((a, b) => b.weight - a.weight)
}

export function skillDef(term: string): SkillDef | undefined {
  return SKILLS.find((s) => s.term === term)
}

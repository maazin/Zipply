import { escapeRegExp, keywordInText } from '@/shared/text'
import { CASE_SENSITIVE, SKILLS, type SkillDef } from './skills'

export type KeywordTier = 'required' | 'preferred' | 'other'

export interface Keyword {
  term: string
  tier: KeywordTier
  tech: boolean
  /** Ranking weight: tier x frequency x specificity (a TF-IDF-style score). */
  weight: number
}

const REQUIRED_HEAD = /^(requirements?|required|must[- ]haves?|minimum qualifications?|basic qualifications?|what you('|’)?ll need|what we('|’)?re looking for|you have|qualifications|who you are|skills( and| &) experience)\b/i
const PREFERRED_HEAD = /^(preferred|nice[- ]to[- ]haves?|bonus|pluses|plus|preferred qualifications?|additional qualifications?|it('|’)?s a plus|extra credit|good to have)\b/i
const OTHER_HEAD = /^(about (us|the company|the team)|benefits|perks|what we offer|compensation|equal opportunity|eeo|our values|why join|responsibilities|what you('|’)?ll do|the role|about the role|day to day)\b/i

/** Split a posting into required / preferred / other text by its headings. */
export function splitPosting(text: string): Record<KeywordTier, string> {
  const out: Record<KeywordTier, string[]> = { required: [], preferred: [], other: [] }
  let tier: KeywordTier = 'other'
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
    // Inline cues inside a bullet override the section.
    let lineTier = tier
    if (/\b(preferred|nice to have|a plus|is a plus|bonus)\b/i.test(line)) lineTier = 'preferred'
    else if (/\b(required|must have|must be|minimum of)\b/i.test(line)) lineTier = 'required'
    out[lineTier].push(line)
  }
  return { required: out.required.join('\n'), preferred: out.preferred.join('\n'), other: out.other.join('\n') }
}

function variants(s: SkillDef): string[] {
  return [s.term, ...s.synonyms]
}

function countIn(variant: string, text: string): number {
  const cs = CASE_SENSITIVE.has(variant)
  const left = /^[\p{L}\p{N}_]/u.test(variant) ? '(?<![\\p{L}\\p{N}_])' : ''
  // Single letters ("C", "R") also refuse "C-suite", "R&D" and "C/C++".
  const tail = variant.length === 1 ? '(?![\\p{L}\\p{N}_+#&/\\-])' : '(?![\\p{L}\\p{N}_+#])'
  const right = /[\p{L}\p{N}_]$/u.test(variant) ? tail : ''
  const re = new RegExp(left + escapeRegExp(variant) + right, cs ? 'gu' : 'giu')
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

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

// Plain words ("Experience", "Skills") count only as the whole heading: a bullet
// starting "Experience with Snowflake" is content.
const REQUIRED_HEAD =
  /^(((key |minimum |basic |essential |core |required )?(requirements?|qualifications?|skills)|experience|education)(\s*(and|&|\/)\s*[\w ]{1,30})?$|required\b|must[- ]haves?\b|minimum qualifications?\b|basic qualifications?\b|what you('|’)?ll (need|bring)\b|what you will (need|bring)\b|what you bring\b|what we('|’)?re looking for\b|you have\b|who you are\b|about you\b|your (skills|experience|background|profile)\b|(the )?ideal candidate\b|skills( and| &) experience\b)/i
const PREFERRED_HEAD = /^(preferred|nice[- ]to[- ]haves?|bonus|pluses|plus|preferred qualifications?|additional qualifications?|it('|’)?s a plus|extra credit|good to have)\b/i
const OTHER_HEAD =
  /^((key |main |core )?responsibilities\b|essential (functions|duties)\b|what you('|’)?ll (do|be doing)\b|what you will (do|be doing)\b|the (role|opportunity|position)\b|your role\b|role (overview|summary)\b|day to day\b|your impact\b|about (the|this) (job|role|position|opportunity)\b|job (description|summary|overview|details|purpose)\b|position (summary|overview|description)\b|(duties|description|overview|summary)$)/i
// About the employer, not the job: its products and perks aren't skills you need.
const IGNORE_HEAD = /^(about (us|the company|the team|[A-Z][\w&.' -]{1,40})|who we are|our (company|mission|story|values|culture|team)|benefits|perks|what we offer|compensation|pay (range|transparency)|salary|equal (employment )?opportunity|eeo|diversity|accommodations?|why (join|work)|life at|privacy|disclaimer|how to apply|application process)\b/i
// Legal and recruiting boilerplate that can sit anywhere.
const BOILERPLATE = /equal opportunity employer|without regard to|regardless of (race|age|gender)|reasonable accommodation|e-?verify|privacy (policy|notice)|applicants? (with|who require)|protected (veteran|status|characteristic)/i

/**
 * Split a posting into required / preferred / other text by its headings.
 * Sections about the employer (About us, Benefits, EEO) are left out.
 */
export function splitPosting(text: string): Record<KeywordTier, string> {
  return split(text).parts
}

/**
 * The posting's lines, long ones cut into sentences. A description given as one
 * line (Workday's structured data has no line breaks) would otherwise be dropped
 * whole for the one sentence of legal boilerplate in it.
 */
function lines(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((l) => (l.length > 300 ? l.split(/(?<=[.!?])\s+(?=[A-Z])/) : [l]))
    .map((l) => l.trim())
    .filter(Boolean)
}

/** The split, and whether a job heading ever followed the employer's section. */
function split(text: string): { parts: Record<KeywordTier, string>; kept: number; skipped: number; lost: boolean } {
  const out: Record<KeywordTier, string[]> = { required: [], preferred: [], other: [] }
  let skipped = 0
  let ignored = false
  let jobHeading = false
  let tier: KeywordTier | 'ignore' = 'other'
  for (const line of lines(text)) {
    const head = line.replace(/^[#*\-•\s]+/, '').replace(/[:：]\s*$/, '')
    const isHeading = head.length < 70 && (/[:：]$/.test(line) || !/[.!?]$/.test(line))
    if (isHeading && PREFERRED_HEAD.test(head)) {
      tier = 'preferred'
      jobHeading = true
      continue
    }
    if (isHeading && REQUIRED_HEAD.test(head)) {
      tier = 'required'
      jobHeading = true
      continue
    }
    if (isHeading && OTHER_HEAD.test(head)) {
      tier = 'other'
      jobHeading = true
      continue
    }
    if (isHeading && IGNORE_HEAD.test(head)) {
      tier = 'ignore'
      ignored = true
      continue
    }
    // Any other heading ends a section about the employer ("Job Description:").
    if (tier === 'ignore' && isHeading && /[:：]$/.test(line)) {
      tier = 'other'
      jobHeading = true
      continue
    }
    if (tier === 'ignore') {
      skipped++
      continue
    }
    if (BOILERPLATE.test(line)) continue
    // Inline cues inside a bullet override the section.
    let lineTier: KeywordTier = tier
    if (/\b(preferred|nice to have|a plus|is a plus|bonus)\b/i.test(line)) lineTier = 'preferred'
    else if (/\b(required|must have|must be|minimum of)\b/i.test(line)) lineTier = 'required'
    out[lineTier].push(line)
  }
  return {
    parts: { required: out.required.join('\n'), preferred: out.preferred.join('\n'), other: out.other.join('\n') },
    kept: out.required.length + out.preferred.length + out.other.length,
    skipped,
    // An employer's section with no job heading after it may have swallowed the job.
    lost: ignored && !jobHeading,
  }
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
/** Fewer technical skills than this and a score means nothing (see MIN_KEYWORDS in lib/checks). */
const FEW = 3

export function extractKeywords(posting: string): Keyword[] {
  const { parts, kept, skipped, lost } = split(posting)
  const found = keywordsIn(parts)
  // A heading the splitter doesn't know can hide the whole job behind "About us".
  // When no job heading came after it, most of the posting was set aside and too
  // few skills are left, read all of it (less its legal boilerplate) rather than
  // show no score.
  if (found.filter((k) => k.tech).length >= FEW || !lost || skipped <= kept) return found
  const whole = lines(posting)
    .filter((l) => !BOILERPLATE.test(l))
    .join('\n')
  const all = keywordsIn({ required: '', preferred: '', other: whole })
  return all.filter((k) => k.tech).length > found.filter((k) => k.tech).length ? all : found
}

function keywordsIn(parts: Record<KeywordTier, string>): Keyword[] {
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

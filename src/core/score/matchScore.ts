/*
 * Ported from Resume-Matcher (https://github.com/srbhr/Resume-Matcher)
 * File: apps/backend/app/services/ats.py (compute_ats_score, _keyword_in_text,
 * _compute_skills_coverage, _compute_section_completeness, _generate_recommendations)
 * License: Apache-2.0. Modified: translated to TypeScript; keyword match is computed
 * here from a skills dictionary instead of an LLM pipeline; required terms count
 * double; missing keywords are split into "Can add" and "Real gap" and only
 * "Can add" terms become tips.
 */
import type { MatchResult, Profile } from '@/shared/types'
import { extractKeywords, hasSkill, skillDef, type Keyword } from './keywords'

// Weights must sum to 1.0 (same as Resume-Matcher's _WEIGHTS).
export const WEIGHTS = { keywordMatch: 0.55, skillsCoverage: 0.25, sectionCompleteness: 0.2 }

// Section heading patterns (Resume-Matcher's _SECTION_PATTERNS).
export const SECTION_PATTERNS: Record<'summary' | 'experience' | 'education' | 'skills', string[]> = {
  summary: ['summary', 'objective', 'profile', 'about'],
  experience: ['experience', 'work history', 'employment'],
  education: ['education', 'academic', 'degree'],
  skills: ['skills', 'technologies', 'competencies', 'technical'],
}

/** Which sections a resume's text has, by heading-like lines first, then anywhere. */
export function detectSections(text: string): Record<keyof typeof SECTION_PATTERNS, boolean> {
  const lines = text.split(/\n+/).map((l) => l.trim().toLowerCase())
  const headingLines = lines.filter((l) => l.length > 0 && l.length < 40)
  const out = {} as Record<keyof typeof SECTION_PATTERNS, boolean>
  for (const [section, pats] of Object.entries(SECTION_PATTERNS) as [keyof typeof SECTION_PATTERNS, string[]][]) {
    out[section] = headingLines.some((l) => pats.some((p) => l.includes(p)))
  }
  if (!Object.values(out).some(Boolean)) {
    const lower = text.toLowerCase()
    for (const [section, pats] of Object.entries(SECTION_PATTERNS) as [keyof typeof SECTION_PATTERNS, string[]][]) {
      out[section] = pats.some((p) => lower.includes(p))
    }
  }
  return out
}

export function sectionCompleteness(text: string): number {
  const found = Object.values(detectSections(text)).filter(Boolean).length
  return (found / Object.keys(SECTION_PATTERNS).length) * 100
}

function weightedMatch(keywords: Keyword[], text: string): { pct: number; matched: Keyword[]; missing: Keyword[] } {
  let total = 0
  let got = 0
  const matched: Keyword[] = []
  const missing: Keyword[] = []
  for (const k of keywords) {
    const w = k.tier === 'required' ? 2 : 1
    total += w
    if (hasSkill(skillDef(k.term) ?? k.term, text)) {
      got += w
      matched.push(k)
    } else missing.push(k)
  }
  return { pct: total ? (got / total) * 100 : 0, matched, missing }
}

/** Resume-Matcher's _compute_skills_coverage: technical required + preferred skills present. */
function skillsCoverage(keywords: Keyword[], text: string, profileSkills: string[]): number {
  const jd = keywords.filter((k) => k.tech && k.tier !== 'other')
  const pool = jd.length ? jd : keywords.filter((k) => k.tech)
  if (!pool.length) return 0
  const listed = new Set(profileSkills.map((s) => s.toLowerCase()))
  let matched = 0
  for (const k of pool) {
    if (listed.has(k.term.toLowerCase()) || hasSkill(skillDef(k.term) ?? k.term, text)) matched++
  }
  return Math.min(100, (matched / pool.length) * 100)
}

/** All the text we know about you, outside the resume being scored. */
export function profileText(p: Profile): string {
  return [
    p.basics.headline,
    p.basics.summary,
    p.skills.join(', '),
    ...p.work.map((w) => `${w.title} ${w.company} ${w.description}`),
    ...p.education.map((e) => `${e.degree} ${e.major} ${e.school}`),
  ].join('\n')
}

function recommendations(kw: number, sk: number, sec: number, canAdd: string[], realGap: string[]): string[] {
  const tips: string[] = []
  if (canAdd.length) tips.push(`You have these but this resume doesn't say so: ${canAdd.slice(0, 5).join(', ')}.`)
  if (sk < 60 && canAdd.length) tips.push('Move the tools you already use into the Skills section, using the posting’s wording.')
  if (sec < 75) tips.push('Make sure the resume has Summary, Experience, Education and Skills headings.')
  if (kw >= 80 && sk >= 80) tips.push('Strong keyword fit. Quantify a few achievements with numbers.')
  if (!tips.length && realGap.length) tips.push('The gaps are real ones. Mention related experience in your answers rather than adding terms you don’t have.')
  if (!tips.length) tips.push('This resume is well aligned with the posting.')
  return tips.slice(0, 3)
}

export interface ScoreInput {
  resumeId: string
  resumeText: string
  posting: string
  profile: Profile
  /** Text of your other resumes, for "Can add". */
  otherResumeTexts?: string[]
  keywords?: Keyword[]
}

export function computeMatch(input: ScoreInput): MatchResult {
  const keywords = input.keywords ?? extractKeywords(input.posting)
  const { pct, matched, missing } = weightedMatch(keywords, input.resumeText)
  const kw = Math.min(100, Math.max(0, pct))
  const sk = skillsCoverage(keywords, input.resumeText, [])
  const sec = sectionCompleteness(input.resumeText)
  const overall = kw * WEIGHTS.keywordMatch + sk * WEIGHTS.skillsCoverage + sec * WEIGHTS.sectionCompleteness

  const elsewhere = [profileText(input.profile), ...(input.otherResumeTexts ?? [])].join('\n')
  const listed = new Set(input.profile.skills.map((s) => s.toLowerCase()))
  const canAdd: string[] = []
  const realGap: string[] = []
  for (const k of missing.slice(0, 10)) {
    if (listed.has(k.term.toLowerCase()) || hasSkill(skillDef(k.term) ?? k.term, elsewhere)) canAdd.push(k.term)
    else realGap.push(k.term)
  }

  return {
    resumeId: input.resumeId,
    score: Math.round(overall),
    keywordMatch: Math.round(kw),
    skillsCoverage: Math.round(sk),
    sectionCompleteness: Math.round(sec),
    matched: matched.map((k) => k.term),
    canAdd,
    realGap,
    tips: recommendations(kw, sk, sec, canAdd, realGap),
  }
}

/** Score every resume and return them best first. */
export function rankResumes(
  resumes: { id: string; text: string }[],
  posting: string,
  profile: Profile,
): MatchResult[] {
  const keywords = extractKeywords(posting)
  return resumes
    .map((r) =>
      computeMatch({
        resumeId: r.id,
        resumeText: r.text,
        posting,
        profile,
        keywords,
        otherResumeTexts: resumes.filter((o) => o.id !== r.id).map((o) => o.text),
      }),
    )
    .sort((a, b) => b.score - a.score)
}

/*
 * Ported from Resume-Matcher (https://github.com/srbhr/Resume-Matcher)
 * File: apps/backend/app/services/ats.py (compute_ats_score, WEIGHTS,
 * _compute_skills_coverage, _compute_title_match, _compute_section_completeness,
 * _compute_date_consistency, _generate_recommendations) and text_match.py
 * (keyword_in_text). License: Apache-2.0. Modified: translated to TypeScript;
 * keywords come from a skills dictionary instead of an LLM pipeline; required
 * terms count double; seniority words ("Junior", "II") are left out of the title
 * match; missing keywords are split into "Can add" and "Real gap" and only
 * "Can add" terms become tips.
 */
import type { MatchResult, Profile } from '@/shared/types'
import { extractKeywords, hasSkill, skillDef, type Keyword } from './keywords'
import { byFit } from './compare'

// Resume-Matcher's WEIGHTS (they sum to 1.0). A part that can't be measured (no
// job title, fewer than two dates) is left out and the rest share its weight.
export const WEIGHTS = { keywordMatch: 0.4, skillsCoverage: 0.2, titleMatch: 0.15, sectionCompleteness: 0.15, dateConsistency: 0.1 }

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

/** The four sections and a way to reach you (an email or a phone number), out of five. */
export function sectionCompleteness(text: string): number {
  const found = Object.values(detectSections(text)).filter(Boolean).length
  const contact = /[\w.+-]+@[\w-]+\.[\w.]+|(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/.test(text) ? 1 : 0
  return ((found + contact) / (Object.keys(SECTION_PATTERNS).length + 1)) * 100
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?'
/** Date styles, most specific first (Resume-Matcher's _DATE_PATTERNS). */
const DATE_STYLES: [string, RegExp][] = [
  ['iso', /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])\b/gi],
  ['numeric', /\b(?:0?[1-9]|1[0-2])\/(?:19|20)\d{2}\b/gi],
  ['name_year', new RegExp(`\\b${MONTH}\\s+(?:19|20)\\d{2}\\b`, 'gi')],
  ['name_short_year', new RegExp(`\\b${MONTH}\\s+['’]\\d{2}\\b`, 'gi')],
  ['year', /\b(?:19|20)\d{2}\b/gi],
]

/** The share of the resume's dates written in its most common style; null under two dates. */
export function dateConsistency(text: string): number | null {
  let rest = text
  const counts: Record<string, number> = {}
  for (const [style, re] of DATE_STYLES) {
    const hits = rest.match(re) ?? []
    if (hits.length) counts[style] = hits.length
    // Each date counts once, in its most specific style.
    rest = rest.replace(re, ' ')
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return total < 2 ? null : (Math.max(...Object.values(counts)) / total) * 100
}

/** Words that say how senior, not what the job is. */
const SENIORITY = /\b(junior|jr|senior|sr|lead|principal|staff|entry[- ]level|associate|intern(ship)?|new grad(uate)?|i{1,3}|iv|[1-4])\b\.?/gi
const STOPWORDS = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'in', 'to', 'at', '&'])
const titleWords = (s: string) =>
  s
    .toLowerCase()
    .replace(SENIORITY, ' ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w))

/**
 * Resume-Matcher's _compute_title_match: the role in your headline (the top of the
 * resume, or your profile's headline) is 100, in the summary 75, else the share of
 * its words there, times 50. Null with no job title.
 */
export function titleMatch(jobTitle: string, resumeText: string, headline = ''): number | null {
  const want = titleWords(jobTitle)
  if (!want.length) return null
  const lines = resumeText.split(/\n+/).map((l) => l.trim()).filter(Boolean)
  const top = [headline, ...lines.slice(0, 3)].join(' ')
  const summaryAt = lines.findIndex((l) => l.length < 40 && SECTION_PATTERNS.summary.some((p) => l.toLowerCase().includes(p)))
  const summary = summaryAt >= 0 ? lines.slice(summaryAt + 1, summaryAt + 6).join(' ') : ''
  const phrase = want.join(' ')
  if (titleWords(top).join(' ').includes(phrase)) return 100
  if (titleWords(summary).join(' ').includes(phrase)) return 75
  const have = new Set(titleWords(`${top} ${summary}`))
  return (want.filter((w) => have.has(w)).length / want.length) * 50
}

function weightedMatch(keywords: Keyword[], text: string): { pct: number; matched: Keyword[]; missing: Keyword[] } {
  let total = 0
  let got = 0
  const matched: Keyword[] = []
  const missing: Keyword[] = []
  for (const k of keywords) {
    // Required terms count double; generic ones ("Agile") count less than tools.
    const w = (k.tier === 'required' ? 2 : 1) * (skillDef(k.term)?.weight ?? 1)
    total += w
    if (hasSkill(skillDef(k.term) ?? k.term, text)) {
      got += w
      matched.push(k)
    } else missing.push(k)
  }
  return { pct: total ? (got / total) * 100 : 0, matched, missing }
}

/** Resume-Matcher's _compute_skills_coverage: technical required + preferred skills present. Null with none to cover. */
function skillsCoverage(keywords: Keyword[], text: string, profileSkills: string[]): number | null {
  const jd = keywords.filter((k) => k.tech && k.tier !== 'other')
  const pool = jd.length ? jd : keywords.filter((k) => k.tech)
  if (!pool.length) return null
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

function recommendations(kw: number, sk: number, sec: number, title: number | null, dates: number | null, canAdd: string[], realGap: string[]): string[] {
  const tips: string[] = []
  if (canAdd.length) tips.push(`You have these but this resume doesn't say so: ${canAdd.slice(0, 5).join(', ')}.`)
  if (sk < 60 && canAdd.length) tips.push('Move the tools you already use into the Skills section, using the posting’s wording.')
  if (title !== null && title < 50) tips.push('Put the job’s title, or the closest one you can honestly claim, in the headline at the top.')
  if (sec < 80) tips.push('Make sure the resume has Summary, Experience, Education and Skills headings, and your email or phone.')
  if (dates !== null && dates < 80) tips.push('Write every date the same way (for example "May 2025").')
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
  /** The job's title, for the title match; without one that part is left out. */
  jobTitle?: string
}

export function computeMatch(input: ScoreInput): MatchResult {
  const keywords = input.keywords ?? extractKeywords(input.posting)
  const { pct, matched, missing } = weightedMatch(keywords, input.resumeText)
  const kw = keywords.length ? Math.min(100, Math.max(0, pct)) : null
  const sk = skillsCoverage(keywords, input.resumeText, [])
  const title = titleMatch(input.jobTitle ?? '', input.resumeText, input.profile.basics.headline)
  const sec = sectionCompleteness(input.resumeText)
  const dates = dateConsistency(input.resumeText)
  // Resume-Matcher's compute_ats_score: a weighted mean over the parts that could be measured.
  const parts: [number | null, number][] = [
    [kw, WEIGHTS.keywordMatch],
    [sk, WEIGHTS.skillsCoverage],
    [title, WEIGHTS.titleMatch],
    [sec, WEIGHTS.sectionCompleteness],
    [dates, WEIGHTS.dateConsistency],
  ]
  const measured = parts.filter((p): p is [number, number] => p[0] !== null)
  const overall = measured.reduce((sum, [v, w]) => sum + v * w, 0) / measured.reduce((sum, [, w]) => sum + w, 0)

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
    keywordMatch: Math.round(kw ?? 0),
    skillsCoverage: Math.round(sk ?? 0),
    sectionCompleteness: Math.round(sec),
    titleMatch: title === null ? null : Math.round(title),
    dateConsistency: dates === null ? null : Math.round(dates),
    matched: matched.map((k) => k.term),
    canAdd,
    realGap,
    tips: recommendations(kw ?? 0, sk ?? 0, sec, title, dates, canAdd, realGap),
  }
}

/** Score every resume and return them best first. */
export function rankResumes(
  resumes: { id: string; text: string }[],
  posting: string,
  profile: Profile,
  jobTitle = '',
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
        jobTitle,
        otherResumeTexts: resumes.filter((o) => o.id !== r.id).map((o) => o.text),
      }),
    )
    .sort(byFit)
}

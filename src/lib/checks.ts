// Before-you-apply checks for one posting. All rules, all in the browser: no AI calls.
import type { AppliedCheck, AtsReport, MatchResult, Posting, Profile, RedFlagResult, VerdictResult } from '@/shared/types'
import { extractKeywords } from '@/core/score/keywords'
import { rankResumes } from '@/core/score/matchScore'
import { compareResumes, type ResumeComparison } from '@/core/score/compare'
import { computeVerdict } from '@/core/score/verdict'
import { computeRedFlags } from '@/core/score/redFlags'
import { checkApplied } from '@/core/score/applied'
import { atsReport } from '@/core/score/atsCheck'
import { db } from './db'
import { getResumeTexts } from './repo'

/** Fewer skills than this in a posting and its match score means nothing. */
export const MIN_KEYWORDS = 3

export interface ChecksResult {
  matches: (MatchResult & { tag: string; name: string; ats: AtsReport })[]
  best: (MatchResult & { tag: string; name: string; ats: AtsReport }) | null
  /** Too few skills in the posting to score it (a clipped or vague description). */
  thin: boolean
  /** All your resumes side by side, best first. */
  comparison: ResumeComparison
  verdict: VerdictResult
  redFlags: RedFlagResult
  applied: AppliedCheck
}

export async function runChecks(posting: Posting, profile: Profile): Promise<ChecksResult> {
  const [resumes, applied] = await Promise.all([getResumeTexts(), db.applied.toArray()])
  const keywords = extractKeywords(posting.description)
  const ranked = posting.description ? rankResumes(resumes.map((r) => ({ id: r.id, text: r.text })), posting.description, profile) : []
  const matches = ranked.map((m) => {
    const r = resumes.find((x) => x.id === m.resumeId)!
    return { ...m, tag: r.tag, name: r.name, ats: atsReport(r.content, keywords) }
  })
  const best = matches[0] ?? null
  const thin = keywords.length < MIN_KEYWORDS
  return {
    matches,
    best,
    thin,
    comparison: compareResumes(matches),
    // A score from almost no keywords is just your resume's section count: don't judge on it.
    verdict: computeVerdict({ posting, profile, matchScore: thin ? null : (best?.score ?? null) }),
    redFlags: computeRedFlags(posting, profile, applied),
    applied: checkApplied(posting, applied),
  }
}

/** Rank your resumes against any job description you paste in. */
export async function compareDescription(description: string, profile: Profile) {
  const resumes = await getResumeTexts()
  const ranked = rankResumes(resumes.map((r) => ({ id: r.id, text: r.text })), description, profile)
  const matches = ranked.map((m) => {
    const r = resumes.find((x) => x.id === m.resumeId)!
    return { ...m, tag: r.tag, name: r.name }
  })
  return { matches, comparison: compareResumes(matches) }
}

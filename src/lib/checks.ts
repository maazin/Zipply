// Before-you-apply checks for one posting. All rules, all in the browser: no AI calls.
import type { AppliedCheck, AtsReport, MatchResult, Posting, Profile, RedFlagResult, VerdictResult } from '@/shared/types'
import { extractKeywords } from '@/core/score/keywords'
import { rankResumes } from '@/core/score/matchScore'
import { computeVerdict } from '@/core/score/verdict'
import { computeRedFlags } from '@/core/score/redFlags'
import { checkApplied } from '@/core/score/applied'
import { atsReport } from '@/core/score/atsCheck'
import { db } from './db'
import { getResumeTexts } from './repo'

export interface ChecksResult {
  matches: (MatchResult & { tag: string; name: string; ats: AtsReport })[]
  best: (MatchResult & { tag: string; name: string; ats: AtsReport }) | null
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
  return {
    matches,
    best,
    verdict: computeVerdict({ posting, profile, matchScore: best?.score ?? null }),
    redFlags: computeRedFlags(posting, profile, applied),
    applied: checkApplied(posting, applied),
  }
}

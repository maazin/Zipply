/*
 * Posting red flags adapted from career-ops (https://github.com/santifer/career-ops)
 * modes/oferta.md, Block G "Posting Legitimacy", MIT. Only the signals rules can
 * check are kept. Range width rule: top - bottom > 0.5 x bottom (career-ops'
 * "unusually wide" heuristic). Tiers: High confidence / Proceed with caution /
 * Suspicious. Flags never change the match score or verdict.
 */
import type { AppliedEntry, LegitimacyTier, Posting, Profile, RedFlagResult } from '@/shared/types'
import { bigramSimilarity, daysBetween, findBadWord, normalizeCompany, wordCount } from '@/shared/text'
import { extractKeywords } from './keywords'
import { CONTRACT_TERMS } from './postingSignals'

export function tierFor(count: number): LegitimacyTier {
  if (count === 0) return 'High confidence'
  if (count <= 2) return 'Proceed with caution'
  return 'Suspicious'
}

export function computeRedFlags(posting: Posting, profile: Profile, applied: AppliedEntry[], now = new Date()): RedFlagResult {
  const flags: string[] = []

  if (posting.datePosted) {
    const age = daysBetween(posting.datePosted, now)
    if (age > 30) flags.push(`Posted ${age} days ago`)
  }

  const company = normalizeCompany(posting.company)
  if (company && posting.title) {
    const repost = applied.find(
      (a) =>
        a.companyNorm === company &&
        bigramSimilarity(a.title, posting.title) >= 0.85 &&
        daysBetween(a.dateApplied, now) <= 90 &&
        (!posting.jobId || a.jobId !== posting.jobId),
    )
    if (repost) flags.push(`Same title at ${posting.company} already in your sheet (${repost.dateApplied}), possibly reposted`)
  }

  if (!posting.salary) flags.push('No salary range')
  else if (posting.salary.max - posting.salary.min > 0.5 * posting.salary.min) {
    const k = (n: number) => (posting.salary!.period === 'hour' ? `$${n}` : `$${Math.round(n / 1000)}k`)
    flags.push(`Wide salary range (${k(posting.salary.min)} to ${k(posting.salary.max)})`)
  }

  const words = wordCount(posting.description)
  const skills = extractKeywords(posting.description).filter((k) => k.tech).length
  if (words < 150) flags.push(`Vague posting (${words} words)`)
  else if (skills < 3) flags.push(`Vague posting (only ${skills} concrete skill${skills === 1 ? '' : 's'} named)`)

  const wantsFullTime = profile.answers.employmentTypes.includes('full-time') && !profile.answers.employmentTypes.includes('contract')
  if (wantsFullTime) {
    const c = findBadWord(posting.description + ' ' + posting.employmentType, CONTRACT_TERMS)
    if (c) flags.push(`Contract wording ("${c}")`)
  }

  return { flags, tier: tierFor(flags.length) }
}

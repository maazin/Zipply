/*
 * Verdict rubric adapted from career-ops (https://github.com/santifer/career-ops)
 * modes/oferta.md, MIT. career-ops asks an AI to score five dimensions; we keep
 * the four rules can judge (role fit, level, logistics, pay) and drop culture.
 * Hard blockers adapted from career-ops' work-authorization check and
 * Auto_job_applier_linkedIn's check_blacklist / get_job_description (MIT).
 */
import type { DimensionResult, Posting, Profile, VerdictResult } from '@/shared/types'
import { totalYears } from '@/shared/profileKeys'
import { findBadWord, normalizeCompany } from '@/shared/text'
import {
  annualize,
  CLEARANCE_TERMS,
  SENIOR_TITLE,
  sponsorshipStance,
  workModeOf,
  yearsRequired,
} from './postingSignals'

export interface VerdictInput {
  posting: Posting
  profile: Profile
  matchScore: number | null
}

/** Company blocklist plus description word filters (from check_blacklist). */
export function blocklistHit(posting: Posting, profile: Profile): string | null {
  const f = profile.filters
  const company = normalizeCompany(posting.company)
  if (company && f.blockedCompanies.some((b) => normalizeCompany(b) === company)) return `${posting.company} is on your blocklist`
  const text = posting.description
  const good = f.companyGoodWords.find((w) => w.trim() && text.toLowerCase().includes(w.toLowerCase()))
  if (!good) {
    const bad = findBadWord(text, f.companyBadWords)
    if (bad) return `Posting mentions "${bad}"`
  }
  const jobBad = findBadWord(text, f.jobBadWords)
  if (jobBad) return `Posting mentions "${jobBad}"`
  return null
}

function roleFit(score: number | null, applyAt: number, maybeAt: number): { result: DimensionResult; note: string } {
  if (score == null) return { result: 'n/a', note: 'Add a resume to score this job' }
  if (score >= applyAt) return { result: 'pass', note: `Match score ${score}` }
  if (score >= maybeAt) return { result: 'warn', note: `Match score ${score}` }
  return { result: 'fail', note: `Match score ${score}` }
}

function level(posting: Posting, profile: Profile): { result: DimensionResult; note: string } {
  const asked = yearsRequired(posting.description)
  const mine = totalYears(profile) ?? 0
  const senior = SENIOR_TITLE.test(posting.title)
  if (asked == null && !senior) return { result: 'pass', note: 'No experience requirement found' }
  if (asked != null && asked > mine + 2) return { result: 'fail', note: `Asks for ${asked}+ years, you have ${Math.floor(mine)}` }
  if (asked != null && asked > mine) return { result: 'warn', note: `Asks for ${asked} years, you have ${Math.floor(mine)}` }
  if (senior && mine < 5) return { result: 'warn', note: `"${posting.title}" reads as a senior title` }
  return { result: 'pass', note: asked != null ? `Asks for ${asked} years` : 'Level fits' }
}

function sameCity(a: string, b: string): boolean {
  const city = (s: string) => s.toLowerCase().split(',')[0].trim()
  return Boolean(city(a)) && city(a) === city(b)
}

function logistics(posting: Posting, profile: Profile): { result: DimensionResult; note: string; blocker?: string } {
  const a = profile.answers
  const stance = sponsorshipStance(posting.description)
  if (a.needsSponsorship === 'Yes' && stance.stance === 'refused') {
    return { result: 'fail', note: `Says "${stance.phrase}"`, blocker: `No sponsorship ("${stance.phrase}") and you need it` }
  }
  const mode = posting.workMode || workModeOf(`${posting.location}\n${posting.description}`)
  if (mode && a.workModes.length && !a.workModes.includes(mode)) {
    return { result: 'warn', note: `${mode[0].toUpperCase()}${mode.slice(1)}, which isn't in your preferences` }
  }
  if (mode && mode !== 'remote' && posting.location && a.locations.length) {
    const near = a.locations.some((l) => sameCity(l, posting.location) || posting.location.toLowerCase().includes(l.toLowerCase()))
    if (!near && a.willingToRelocate !== 'Yes') return { result: 'warn', note: `${posting.location} isn't one of your locations` }
  }
  return { result: 'pass', note: [mode || 'Location', posting.location].filter(Boolean).join(', ') }
}

function pay(posting: Posting, profile: Profile): { result: DimensionResult; note: string } {
  const min = profile.answers.minSalary
  if (!posting.salary) return { result: 'n/a', note: 'No range posted' }
  const yr = annualize(posting.salary)
  if (!yr || !min) return { result: 'n/a', note: 'Range posted' }
  const k = (n: number) => `$${Math.round(n / 1000)}k`
  if (yr.max < min) return { result: 'fail', note: `Tops out at ${k(yr.max)}, below your ${k(min)}` }
  if (yr.min < min) return { result: 'warn', note: `${k(yr.min)} to ${k(yr.max)}, starts below your ${k(min)}` }
  return { result: 'pass', note: `${k(yr.min)} to ${k(yr.max)}` }
}

export function computeVerdict(input: VerdictInput): VerdictResult {
  const { posting, profile } = input
  const { applyAt, maybeAt } = profile.filters
  const blockers: string[] = []

  const fit = roleFit(input.matchScore, applyAt, maybeAt)
  const lvl = level(posting, profile)
  const log = logistics(posting, profile)
  const money = pay(posting, profile)
  if (log.blocker) blockers.push(log.blocker)

  const block = blocklistHit(posting, profile)
  if (block) blockers.push(block)
  if (profile.answers.hasSecurityClearance === 'No') {
    const c = findBadWord(posting.description, CLEARANCE_TERMS)
    if (c) blockers.push(`Asks for "${c}" and you don't have a clearance`)
  }

  const dimensions: VerdictResult['dimensions'] = [
    { name: 'Role fit', ...fit },
    { name: 'Level', ...lvl },
    { name: 'Logistics', result: log.result, note: log.note },
    { name: 'Pay', ...money },
  ]
  const fails = dimensions.filter((d) => d.result === 'fail')
  const warns = dimensions.filter((d) => d.result === 'warn')

  if (blockers.length) return { verdict: 'Skip', reason: blockers[0], dimensions, blockers }

  const score = input.matchScore
  if (score != null && score < maybeAt) return { verdict: 'Skip', reason: `Match score ${score} is below ${maybeAt}`, dimensions, blockers }
  if (fails.length >= 2) return { verdict: 'Skip', reason: `${fails[0].name}: ${fails[0].note}`, dimensions, blockers }
  const problems = [...fails.filter((d) => d.name !== 'Role fit'), ...warns.filter((d) => d.name !== 'Role fit')]
  if (score != null && score >= applyAt && !problems.length) return { verdict: 'Apply', reason: `Strong match (${score}) and nothing fails`, dimensions, blockers }
  const why = problems[0] ? `${problems[0].name}: ${problems[0].note}` : score != null ? `Match score ${score}` : 'No resume to score against'
  return { verdict: 'Maybe', reason: why, dimensions, blockers }
}

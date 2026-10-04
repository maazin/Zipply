/*
 * Already-applied lookup ported from Auto_job_applier_linkedIn
 * (https://github.com/GodsScion/Auto_job_applier_linkedIn) runAiBot.py
 * get_applied_job_ids, MIT. Modified: translated to TypeScript; keys combine the
 * normalized company with the job ID (or the posting URL), and a softer
 * "Possibly applied" match catches one job posted on two ATS sites.
 */
import type { AppliedCheck, AppliedEntry, Posting } from '@/shared/types'
import { bigramSimilarity, daysBetween, normalizeCompany } from '@/shared/text'

/** Strip tracking params and fragments so the same posting has one URL. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|gh_src|source|ref|lever-source|src)/i.test(p)) u.searchParams.delete(p)
    u.pathname = u.pathname.replace(/\/(apply|application|thanks|confirmation)(\/.*)?$/i, '').replace(/\/$/, '')
    return u.toString()
  } catch {
    return url
  }
}

export function appliedKey(company: string, jobId: string, url: string): string {
  const c = normalizeCompany(company)
  return jobId ? `${c}|${jobId.trim().toLowerCase()}` : `url|${canonicalUrl(url)}`
}

/** The lookup set, like get_applied_job_ids but keyed for any ATS. */
export function buildAppliedSet(entries: AppliedEntry[]): Set<string> {
  const s = new Set<string>()
  for (const e of entries) {
    if (e.jobId) s.add(appliedKey(e.company, e.jobId, ''))
    if (e.url) s.add(appliedKey('', '', e.url))
  }
  return s
}

export function checkApplied(posting: Posting, entries: AppliedEntry[], now = new Date()): AppliedCheck {
  const byKey = new Map<string, AppliedEntry>()
  for (const e of entries) {
    if (e.jobId) byKey.set(appliedKey(e.company, e.jobId, ''), e)
    if (e.url) byKey.set(appliedKey('', '', e.url), e)
  }
  const exact =
    (posting.jobId && byKey.get(appliedKey(posting.company, posting.jobId, ''))) ||
    (posting.url && byKey.get(appliedKey('', '', posting.url))) ||
    null
  if (exact) return { alreadyApplied: exact, possiblyApplied: null }

  const company = normalizeCompany(posting.company)
  const possible =
    (company &&
      entries.find(
        (e) =>
          e.companyNorm === company &&
          bigramSimilarity(e.title, posting.title) >= 0.85 &&
          daysBetween(e.dateApplied, now) <= 60 &&
          (!posting.jobId || e.jobId !== posting.jobId),
      )) ||
    null
  return { alreadyApplied: null, possiblyApplied: possible }
}

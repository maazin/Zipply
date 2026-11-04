/*
 * Already-applied lookup ported from Auto_job_applier_linkedIn
 * (https://github.com/GodsScion/Auto_job_applier_linkedIn) runAiBot.py
 * get_applied_job_ids, MIT. Modified: translated to TypeScript; keys combine the
 * normalized company with the job ID (or the posting URL), and a softer
 * "Possibly applied" match catches one job posted on two ATS sites.
 */
import type { AppliedCheck, AppliedEntry, Posting } from '@/shared/types'
import { bigramSimilarity, normalizeCompany } from '@/shared/text'

/** A path part that names one job: a number or an ID. */
const JOB_ID = /\d{3,}|[0-9a-f]{8}-[0-9a-f]{4}/i

/** Strip tracking params and fragments so the same posting has one URL. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|gh_src|source|ref|lever-source|src)/i.test(p)) u.searchParams.delete(p)
    // ".../123/apply" is job 123; but in "/apply/123" the job is after it, so that stays.
    const tail = u.pathname.match(/\/(apply|application|thanks|confirmation)(\/.*)?$/i)
    if (tail && !(JOB_ID.test(tail[2] ?? '') && !JOB_ID.test(u.pathname.slice(0, tail.index)))) u.pathname = u.pathname.slice(0, tail.index)
    u.pathname = u.pathname.replace(/\/$/, '')
    return u.toString()
  } catch {
    return url
  }
}

export function appliedKey(company: string, jobId: string, url: string): string {
  const c = normalizeCompany(company)
  return jobId ? `${c}|${jobId.trim().toLowerCase()}` : `url|${canonicalUrl(url)}`
}

/**
 * The local key for one application: its job, else its posting, else the row
 * itself. Rows with neither (found in email) all keyed "url|" and overwrote each other.
 */
export function entryKey(company: string, jobId: string, url: string, appId: string): string {
  return jobId.trim() || url.trim() ? appliedKey(company, jobId, url) : `row|${appId}`
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

export function checkApplied(posting: Posting, entries: AppliedEntry[]): AppliedCheck {
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

  // The same employer: "Scale AI" and "Scaleai" too.
  const squash = (s: string) => normalizeCompany(s).replace(/ /g, '')
  const company = squash(posting.company)
  const sameCo = company ? entries.filter((e) => squash(e.company) === company && (!posting.jobId || e.jobId !== posting.jobId)) : []
  const newest = (xs: AppliedEntry[]) => [...xs].sort((a, b) => (b.dateApplied || '').localeCompare(a.dateApplied || ''))[0] ?? null
  // The same role there (posted again, or on another site), however long ago; else
  // an application there whose role wasn't saved (found in email): the company is
  // all there is to go on.
  const possible =
    newest(sameCo.filter((e) => e.title.trim() && posting.title && bigramSimilarity(e.title, posting.title) >= 0.85)) ??
    newest(sameCo.filter((e) => !e.title.trim()))
  return { alreadyApplied: null, possiblyApplied: possible }
}

/** "Oct 22, 2026" for "2026-10-22"; a date that isn't one stays as it is. */
export function appliedDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** One line for an application you made, or might have, for the page and the panel. */
export function appliedLine(c: AppliedCheck): { text: string; sure: boolean } | null {
  const e = c.alreadyApplied ?? c.possiblyApplied
  if (!e) return null
  const when = e.dateApplied ? ` on ${appliedDay(e.dateApplied)}` : ''
  const status = e.status && e.status !== 'Applied' ? ` · ${e.status}` : ''
  if (c.alreadyApplied) return { text: `You applied${when}${status}`, sure: true }
  return {
    text: e.title.trim() ? `You applied for “${e.title.trim()}” here${when}${status}` : `You applied to ${e.company}${when}${status} (role not saved)`,
    sure: false,
  }
}

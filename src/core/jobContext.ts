// One job, followed across pages: the posting you read, the "Apply" click, the
// application form (often on another site), and the thank-you page. Pages
// later in the flow rarely carry the full posting, so they continue the job
// you were on instead of replacing it.
import type { Posting } from '@/shared/types'
import { normalizeCompany } from '@/shared/text'
import { canonicalUrl } from '@/core/score/applied'

/** A job you looked at this long ago still counts as the one you're applying to. */
export const JOB_TTL = 2 * 60 * 60_000

/** Enough text that the page is a posting of its own, not just a form. */
const OWN_DESCRIPTION = 400

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** "Senior Data Analyst" vs "Apply for Senior Data Analyst (Remote)". */
export function titlesMatch(a: string, b: string): boolean {
  const x = norm(a)
  const y = norm(b)
  return Boolean(x && y && (x === y || (x.length >= 6 && y.includes(x)) || (y.length >= 6 && x.includes(y))))
}

export function samePosting(a: Posting, b: Posting): boolean {
  if (a.jobId && b.jobId) return a.jobId === b.jobId && normalizeCompany(a.company) === normalizeCompany(b.company)
  return canonicalUrl(a.url) === canonicalUrl(b.url)
}

const hostOf = (u: string | undefined) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

export interface JobSoFar {
  posting: Posting
  /** When this tab last saw the job. */
  at?: number
  /** You filled a form for it. */
  filledAt?: number
  /** The page where it was last seen (the form, after "Apply"). */
  lastUrl?: string
}

/**
 * Does the posting read from this page continue the job you were on? Yes for
 * the same posting, the same job ID or title, or a page without a description
 * of its own (an application form). No for a different posting with its own
 * description, a different job on the same site, a new site after you
 * already filled a form, or when the job you were on is hours old.
 */
export function continuesJob(prev: JobSoFar, next: Posting | null, now = Date.now()): boolean {
  if (!next) return true
  const a = prev.posting
  if (samePosting(a, next)) return true
  if (prev.at && now - prev.at > JOB_TTL) return false
  const sameSite = hostOf(prev.lastUrl ?? a.url) === hostOf(next.url)
  // Two different job IDs on one site are two jobs.
  if (sameSite && a.jobId && next.jobId && a.jobId !== next.jobId) return false
  // Filled a form on one site and now on a named job elsewhere: a new application.
  if (prev.filledAt && !sameSite && (next.title || next.company)) return false
  if (a.jobId && next.jobId && a.jobId === next.jobId) return true
  if (titlesMatch(a.title, next.title)) return true
  // A full posting for another role, even at the same company, is a new job.
  return next.description.length < OWN_DESCRIPTION
}

/** Keep everything known about the job; fill in only what's missing, and the longer description. */
export function mergePostingInto(prev: Posting, next: Posting | null): Posting {
  if (!next) return prev
  const out: Posting = { ...prev }
  for (const k of Object.keys(next) as (keyof Posting)[]) {
    const v = next[k]
    if ((out[k] === '' || out[k] == null) && v !== '' && v != null) (out as unknown as Record<string, unknown>)[k] = v
  }
  if (next.description.length > prev.description.length) out.description = next.description
  // The posting's own address stays: it identifies the job in your sheet.
  out.url = prev.url || next.url
  return out
}

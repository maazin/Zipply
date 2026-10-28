// Turn a confirmed submission into a sheet row. Duplicates (same company + job ID,
// or same posting URL) are skipped; failures go to the retry queue.
import type { AppliedEntry, AppStatus, AtsName, JobRecord, Posting } from '@/shared/types'
import type { JobContext, LogResult } from '@/shared/messages'
import { uid } from '@/shared/defaults'
import { todayISO } from '@/shared/text'
import { appliedKey, buildAppliedSet, canonicalUrl } from '@/core/score/applied'
import { entryFromRecord } from '@/core/sheets/layout'
import { db } from '@/lib/db'
import { appendRecord, FROM_EMAIL } from './sheets'
import { enqueue } from './queue'
import { NotConnectedError } from './google'

export function recordFrom(job: Pick<JobContext, 'posting' | 'ats' | 'resumeTag' | 'match' | 'verdict' | 'redFlags'>, now = new Date()): JobRecord {
  const p = job.posting
  return {
    appId: uid(6),
    dateApplied: todayISO(now),
    company: p.company,
    title: p.title,
    location: [p.location, p.workMode && !p.location.toLowerCase().includes(p.workMode) ? `(${p.workMode[0].toUpperCase()}${p.workMode.slice(1)})` : ''].filter(Boolean).join(' '),
    jobId: p.jobId,
    ats: job.ats,
    url: canonicalUrl(p.url),
    resumeUsed: job.resumeTag,
    matchScore: job.match?.score ?? '',
    verdict: job.verdict?.verdict ?? '',
    redFlags: job.redFlags?.flags.join('; ') ?? '',
    status: 'Applied',
    firstReply: '',
    lastStatusChange: todayISO(now),
    notes: '',
  }
}

/** Minimal context when a confirmation is seen without the panel having run. */
export function bareContext(ats: AtsName, url: string, posting: Posting | null): JobContext {
  return {
    posting: posting ?? {
      title: '',
      company: '',
      location: '',
      description: '',
      datePosted: '',
      salary: null,
      employmentType: '',
      jobId: '',
      url,
      workMode: '',
    },
    ats,
    resumeId: null,
    resumeTag: '',
    match: null,
    verdict: null,
    redFlags: null,
    applied: null,
  }
}

export async function isDuplicate(p: Posting): Promise<AppliedEntry | null> {
  const entries = await db.applied.toArray()
  const set = buildAppliedSet(entries)
  const byJob = p.jobId ? appliedKey(p.company, p.jobId, '') : ''
  const byUrl = p.url ? appliedKey('', '', p.url) : ''
  if ((byJob && set.has(byJob)) || (byUrl && set.has(byUrl))) {
    return entries.find((e) => (byJob && appliedKey(e.company, e.jobId, '') === byJob) || (byUrl && e.url && appliedKey('', '', e.url) === byUrl)) ?? null
  }
  return null
}

export async function logJob(job: JobContext, dateApplied?: string): Promise<LogResult> {
  if (!job.posting.company && !job.posting.title) return { ok: false, error: "Couldn't read the company or title from this page." }
  await db.unlogged.delete(canonicalUrl(job.posting.url)).catch(() => undefined)
  const dup = await isDuplicate(job.posting)
  if (dup) return { ok: true, duplicate: true, appId: dup.appId }

  // Logged later (from "Since last time"): the application date is when you filled it.
  const rec = recordFrom(job, job.filledAt && Date.now() - job.filledAt < 30 * 86_400_000 ? new Date(job.filledAt) : new Date())
  if (dateApplied) Object.assign(rec, { dateApplied, lastStatusChange: dateApplied })
  return saveRecord(rec)
}

/** Into the local cache, then the sheet (or the retry queue). */
async function saveRecord(rec: JobRecord): Promise<LogResult> {
  const entry = entryFromRecord(rec)
  // Record locally first, so the already-applied check works even offline.
  await db.applied.put(entry)

  try {
    const row = await appendRecord(rec)
    if (row) await db.applied.update(entry.key, { row })
    return { ok: true, appId: rec.appId }
  } catch (e) {
    await enqueue('append', rec, e instanceof Error ? e.message : String(e))
    return { ok: true, queued: true, appId: rec.appId, error: e instanceof NotConnectedError ? 'Saved; it will reach your sheet once Google is connected.' : undefined }
  }
}

/**
 * An application found in your email that the sheet doesn't have: made before
 * Zipply or without it. A confirmation dates it; a rejection alone leaves the
 * date blank, since the email doesn't say when you applied.
 */
export async function logFromEmail(d: { company: string; title: string; ats: AtsName; status: AppStatus; date: string; subject: string }): Promise<LogResult> {
  const rec = recordFrom(bareContext(d.ats, '', { ...bareContext(d.ats, '', null).posting, company: d.company, title: d.title }))
  Object.assign(rec, {
    dateApplied: d.status === 'Rejected' ? '' : d.date,
    status: d.status,
    firstReply: d.date,
    lastStatusChange: d.date,
    notes: `${FROM_EMAIL}: "${d.subject.slice(0, 80)}"`,
  })
  return saveRecord(rec)
}

/** With nothing logged yet, applications the site reports go back this far. */
const BACKFILL_DAYS = 14

let applying: Promise<unknown> = Promise.resolve()

/**
 * The site says you applied (Handshake applies inside its own page, with no
 * confirmation page to catch). Logs each one not in the sheet yet, dated the day
 * the site gives. Applications from before your first logged one are left out:
 * they predate Zipply. One batch at a time, so a job is never logged twice.
 */
export function logApplied(jobs: { posting: Posting; date: string }[], ats: AtsName, contextFor: (p: Posting) => Promise<Partial<JobContext>>): Promise<{ logged: number }> {
  const run = applying.then(async () => {
    const entries = await db.applied.toArray()
    const since = entries.map((e) => e.dateApplied).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()[0] ?? todayISO(new Date(Date.now() - BACKFILL_DAYS * 86_400_000))
    let logged = 0
    for (const j of [...jobs].sort((a, b) => a.date.localeCompare(b.date))) {
      if (j.date < since || (await isDuplicate(j.posting))) continue
      const job = { ...bareContext(ats, j.posting.url, j.posting), ...(await contextFor(j.posting).catch(() => ({}))) }
      const res = await logJob(job, j.date)
      if (res.ok && !res.duplicate) logged++
    }
    return { logged }
  })
  applying = run.catch(() => undefined)
  return run
}

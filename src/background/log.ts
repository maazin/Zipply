// Turn a confirmed submission into a sheet row. Duplicates (same company + job ID,
// or same posting URL) are skipped; failures go to the retry queue.
import type { AppliedEntry, AtsName, JobRecord, Posting } from '@/shared/types'
import type { JobContext, LogResult } from '@/shared/messages'
import { uid } from '@/shared/defaults'
import { todayISO } from '@/shared/text'
import { appliedKey, buildAppliedSet, canonicalUrl } from '@/core/score/applied'
import { entryFromRecord } from '@/core/sheets/layout'
import { db } from '@/lib/db'
import { getSettings } from '@/lib/repo'
import { appendRecord } from './sheets'
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

export async function logJob(job: JobContext): Promise<LogResult> {
  if (!job.posting.company && !job.posting.title) return { ok: false, error: "Couldn't read the company or title from this page." }
  const dup = await isDuplicate(job.posting)
  if (dup) return { ok: true, duplicate: true, appId: dup.appId }

  const rec = recordFrom(job)
  const entry = entryFromRecord(rec)
  // Record locally first, so the already-applied check works even offline.
  await db.applied.put(entry)

  const settings = await getSettings()
  if (!settings.sheetId && !settings.googleEmail) {
    await enqueue('append', rec, 'Google not connected yet')
    return { ok: true, queued: true, appId: rec.appId }
  }
  try {
    const row = await appendRecord(rec)
    if (row) await db.applied.update(entry.key, { row })
    return { ok: true, appId: rec.appId }
  } catch (e) {
    await enqueue('append', rec, e instanceof Error ? e.message : String(e))
    return { ok: true, queued: true, appId: rec.appId, error: e instanceof NotConnectedError ? 'Saved; it will reach your sheet once Google is connected.' : undefined }
  }
}

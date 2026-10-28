// Gmail status sync (read-only). Every 2 hours: search the last 30 days of mail
// from ATS domains and companies in the sheet, match each new email to one
// application, classify it, and move the Status column forward. A confirmation or
// rejection for an application the sheet doesn't have adds it. Email content is
// read in memory only; just the resulting status and date are kept.
import type { AppliedEntry, AppStatus, StatusEvent } from '@/shared/types'
import { uid } from '@/shared/defaults'
import { daysBetween, todayISO, toISODate } from '@/shared/text'
import { buildDiscoveryQuery, buildQueries, classifyEmail, discoverApplication, isJobAlert, matchApplication, nextStatus, sameCompany, titleIn, type Discovered } from '@/core/gmail/rules'
import { db } from '@/lib/db'
import { getSettings, updateSettings } from '@/lib/repo'
import { gfetch, HttpError, SCOPES } from './google'
import { refreshApplied, removeEmailRows, writeStatus } from './sheets'
import { enqueue } from './queue'
import { classifyEmailAi } from './ai/tasks'
import { offscreen } from './ai/router'
import { logFromEmail } from './log'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const S = [SCOPES.drive, SCOPES.gmail]

interface Part {
  mimeType: string
  body?: { data?: string }
  parts?: Part[]
  headers?: { name: string; value: string }[]
}

interface Message {
  id: string
  internalDate: string
  payload: Part
}

function b64url(data: string): string {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

function findPart(p: Part, mime: string): Part | null {
  if (p.mimeType === mime && p.body?.data) return p
  for (const c of p.parts ?? []) {
    const hit = findPart(c, mime)
    if (hit) return hit
  }
  return null
}

function header(m: Message, name: string): string {
  return m.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

/** Full body text. Classification never relies on the snippet. */
async function bodyText(m: Message): Promise<string> {
  const plain = findPart(m.payload, 'text/plain')
  const text = plain?.body?.data ? b64url(plain.body.data) : ''
  // Some senders (Paycom) put HTML in the plain-text part.
  if (text && !/^\s*<(!doctype|html)/i.test(text)) return text
  const html = findPart(m.payload, 'text/html')?.body?.data
  const source = html ? b64url(html) : text
  if (!source) return ''
  const r = await offscreen<{ text?: string }>({ type: 'html2text', html: source })
  return r?.text ?? ''
}

/** Enough for months of job mail: newest first, so a lower cap dropped older rejections. */
async function listIds(q: string, max = 1000): Promise<string[]> {
  const ids: string[] = []
  let pageToken = ''
  do {
    const res = await gfetch<{ messages?: { id: string }[]; nextPageToken?: string }>(
      `${API}/messages?q=${encodeURIComponent(q)}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`,
      S,
    )
    ids.push(...(res.messages ?? []).map((m) => m.id))
    pageToken = res.nextPageToken ?? ''
  } while (pageToken && ids.length < max)
  return ids
}

async function addEvent(e: Omit<StatusEvent, 'id' | 'seen'>) {
  await db.events.put({ ...e, id: uid(8), seen: false })
}

/** Apply a status to one application, locally and in the sheet. */
export async function applyStatus(entry: AppliedEntry, to: AppStatus, date: string, note: string, kind: StatusEvent['kind'] = 'change') {
  const firstReply = entry.firstReply || date
  await db.applied.update(entry.key, { status: to, firstReply, lastStatusChange: date })
  const update = { appId: entry.appId, status: to, firstReply, lastStatusChange: date }
  try {
    await writeStatus(update)
  } catch (e) {
    await enqueue('status', update, e instanceof Error ? e.message : String(e))
  }
  await addEvent({ appId: entry.appId, company: entry.company, title: entry.title, from: entry.status, to, at: Date.now(), kind, note })
}

export interface SyncResult {
  scanned: number
  changed: number
  unmatched: number
  /** Applications found in email that the sheet didn't have. */
  added?: number
  /** Stopped early at Gmail's rate limit; continues in a couple of minutes. */
  limited?: boolean
}

/** Same name as the service worker's 2-hourly alarm, so a retry replaces it. */
const GMAIL_ALARM = 'zipply-gmail'
/** About 4 messages a second, well under Gmail's per-user limit. */
const PACE_MS = 250

function isRateLimit(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 429 || (e.status === 403 && /quota|rate limit|rateLimit/i.test(e.message)))
}

let syncing = false

/**
 * Bump when the rules change in a way that should revisit emails already seen.
 * 2: dates read from the sheet as numbers hid every application, so emails
 *    were marked done without a match; more ATS senders and phrases.
 * 3: a title of "Apply" matched every "applying" email and tied with the real
 *    company; repeat rows for one job; sender names; German, French, Spanish
 *    and Dutch phrases; a grace period for late-logged applications.
 * 4: a match needs the company named in the email, not just the role title.
 * 5: rejections worded "won't be moving forward", "decided not to progress",
 *    "not a match" and the like were read as Received; every company is searched,
 *    not only the first 40.
 * 6: confirmations and rejections for applications not in the sheet add them.
 * 7: rows found in email no longer share one local key (6 added some twice and
 *    couldn't move them on a later rejection); mailing services aren't employers.
 *    What 6 added is removed and found again.
 * 8: a job title stops a new row only for the same hiring system (7 skipped P&G's
 *    rejection over another "Software Engineer" that week); "TixTrack has been
 *    received" is TixTrack. What 6 and 7 added is found again.
 * 9: a company name inside a word ("Infor" in "regret to inform") matched every
 *    rejection to it; text after blank lines was cut off; searches stopped at 300
 *    emails. What 6 to 8 added is found again.
 * 10: job alerts ("one new job matching your profile") are skipped: a listing's
 *    "Onsite" read as an interview. What 6 to 9 added is found again.
 * 11: Handshake's "application sent" notes, whose "similar jobs" named other
 *    applications, are skipped; a rejection mentioning a "talent community" isn't
 *    an alert; "Additional Details" isn't a company. What 6 to 10 added is found again.
 */
export const RULES_VERSION = 11
/** An email can arrive a few days before the row's date (logged late, time zones). */
const GRACE_DAYS = 3
/** Emails about applications Zipply didn't log, from this long before the first one it did. */
const DISCOVER_DAYS = 14

/**
 * The sheet may already have this application under another name ("Tripactions"
 * for Navan): the same employer, or a job from those days, through the same hiring
 * system, whose title the email names. Not any job with that title: "Software
 * Engineer" is in half the emails of a week.
 */
async function knownAs(found: Discovered, text: string, date: string): Promise<boolean> {
  const near = (d: string) => Boolean(d) && Math.abs(Date.parse(d) - Date.parse(date)) <= GRACE_DAYS * 86_400_000
  const lower = text.toLowerCase()
  return (await db.applied.toArray()).some(
    (a) => sameCompany(a.company, found.company) || (found.ats !== 'Other' && a.ats === found.ats && near(toISODate(a.dateApplied)) && titleIn(a.title, lower)),
  )
}

export async function syncGmail(): Promise<SyncResult> {
  const settings = await getSettings()
  if (!settings.gmailEnabled || syncing) return { scanned: 0, changed: 0, unmatched: 0 }
  syncing = true
  try {
    // Start from the sheet as it is now (and with dates read as dates).
    await refreshApplied().catch(() => undefined)
    const cutoff = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10)
    const applied = async () => (await db.applied.toArray()).map((a) => ({ ...a, dateApplied: toISODate(a.dateApplied) }))
    // Rules changed since these emails were looked at: look again.
    // Recorded right away, so a run cut short keeps its progress instead of starting over.
    if ((settings.gmailRulesVersion ?? 0) < RULES_VERSION) {
      // Versions 6 to 10 added rows wrongly; later ones keep what you've edited.
      if (settings.gmailRulesVersion >= 6 && settings.gmailRulesVersion <= 10) {
        await removeEmailRows()
        await refreshApplied()
      }
      await Promise.all([db.emails.clear(), db.unmatched.clear()])
      await updateSettings({ gmailRulesVersion: RULES_VERSION, gmailDiscoverSince: '' })
    }
    const apps = (await applied()).filter((a) => !a.dateApplied || a.dateApplied >= cutoff)
    if (!apps.length) return { scanned: 0, changed: 0, unmatched: 0 }

    // Companies you're still waiting on, newest first; searched back to the oldest of them.
    const open = apps.filter((a) => a.status !== 'Rejected' && a.status !== 'Offer').sort((a, b) => (b.dateApplied || '').localeCompare(a.dateApplied || ''))
    const oldest = open.map((a) => a.dateApplied).filter(Boolean).sort()[0]
    const days = Math.min(120, Math.max(30, oldest ? daysBetween(oldest) + GRACE_DAYS + 1 : 30))
    const ids: string[] = []
    for (const q of buildQueries(open.map((a) => a.company), days)) ids.push(...(await listIds(q)))
    // Applications made without Zipply, back to two weeks before the first one it
    // logged. Fixed once: the ones found in email would otherwise move it back each time.
    let since = (await getSettings()).gmailDiscoverSince
    if (!since) {
      const first = apps.map((a) => a.dateApplied).filter(Boolean).sort()[0]
      since = todayISO(new Date((first ? Date.parse(first) : Date.now()) - DISCOVER_DAYS * 86_400_000))
      await updateSettings({ gmailDiscoverSince: since })
    }
    ids.push(...(await listIds(buildDiscoveryQuery(Math.min(120, daysBetween(since) + 1)))))
    const seen = new Set((await db.emails.bulkGet(ids)).filter(Boolean).map((r) => r!.id))
    // Oldest first, so statuses advance in order. Gmail's IDs grow with time.
    const fresh = [...new Set(ids)].filter((id) => !seen.has(id)).sort((a, b) => a.length - b.length || a.localeCompare(b))
    let changed = 0
    let unmatched = 0
    let added = 0

    for (const id of fresh) {
      let m: Message
      try {
        m = await gfetch<Message>(`${API}/messages/${id}?format=full`, S)
      } catch (e) {
        // Gmail's per-minute limit: keep what's done and pick up again shortly.
        if (!isRateLimit(e)) throw e
        await chrome.alarms.create(GMAIL_ALARM, { delayInMinutes: 2, periodInMinutes: 120 })
        return { scanned: fresh.indexOf(id), changed, unmatched, added, limited: true }
      }
      // A big backlog (the first sync, or a rescan) goes at a steady pace.
      if (fresh.length > 20) await new Promise((r) => setTimeout(r, PACE_MS))
      const email = { from: header(m, 'From'), subject: header(m, 'Subject'), body: await bodyText(m) }
      // Job alerts and account mail: not about an application, and not for the AI to guess at.
      if (isJobAlert(email.subject, email.body, email.from)) {
        await db.emails.put({ id, at: Date.now() })
        continue
      }
      const date = todayISO(new Date(Number(m.internalDate)))
      // Only applications in the search window, and only ones that existed when
      // the email was sent: an old rejection must not close a new application.
      const latest = todayISO(new Date(Number(m.internalDate) + GRACE_DAYS * 86_400_000))
      const open = (await applied()).filter((a) => (!a.dateApplied || a.dateApplied >= cutoff) && (!a.dateApplied || a.dateApplied <= latest))
      const { entry, candidates, also = [] } = matchApplication(email, open)
      let status = classifyEmail(email.subject, email.body)

      const found = !entry && !candidates.length && date >= since ? discoverApplication(email, status) : null
      if (found && !(await knownAs(found, `${email.subject}\n${email.body}`, date))) {
        await logFromEmail({ ...found, status: status!, date, subject: email.subject })
        added++
      } else if (!entry) {
        if (status || candidates.length) {
          await db.unmatched.put({ messageId: id, reason: candidates.length ? 'Matches more than one application' : 'No matching application', candidates: candidates.map((c) => c.appId), at: Date.now() })
          unmatched++
        }
      } else {
        if (!status) status = await classifyEmailAi(email.subject, email.body, settings.cloudEmailFallback)
        if (!status) {
          await db.unmatched.put({ messageId: id, reason: 'Couldn’t tell what this email means', candidates: [entry.appId], at: Date.now() })
          unmatched++
        } else {
          const t = nextStatus(entry.status, status)
          if (t.kind === 'apply') {
            await applyStatus(entry, t.to, date, `From "${email.subject}"`)
            // The same job logged twice moves together.
            for (const twin of also) if (nextStatus(twin.status, status).kind === 'apply') await applyStatus(twin, t.to, date, `From "${email.subject}"`)
            changed++
          } else if (t.kind === 'offer') {
            await applyStatus(entry, 'Offer', date, 'Offer received. Your decision; nothing was done.', 'offer')
            changed++
          } else if (t.kind === 'conflict') {
            await addEvent({ appId: entry.appId, company: entry.company, title: entry.title, from: entry.status, to: status, at: Date.now(), kind: 'conflict', note: t.reason })
          } else if (!entry.firstReply) {
            // No status change, but this is their first reply: record it in the sheet too.
            await db.applied.update(entry.key, { firstReply: date })
            const update = { appId: entry.appId, status: entry.status, firstReply: date, lastStatusChange: entry.lastStatusChange || date }
            await writeStatus(update).catch((e) => enqueue('status', update, e instanceof Error ? e.message : String(e)))
          }
        }
      }
      await db.emails.put({ id, at: Date.now() })
    }
    await updateSettings({ lastGmailSync: Date.now() })
    return { scanned: fresh.length, changed, unmatched, added }
  } finally {
    syncing = false
  }
}

/** Subject, sender and date for one message, fetched on demand for the review list (not stored). */
export async function messageSummary(id: string): Promise<{ from: string; subject: string; date: string }> {
  const m = await gfetch<Message>(`${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, S)
  return { from: header(m, 'From'), subject: header(m, 'Subject'), date: todayISO(new Date(Number(m.internalDate))) }
}

/** You assigned an unclear email by hand. */
export async function assignEmail(messageId: string, appId: string, status: AppStatus): Promise<void> {
  const entry = await db.applied.where('appId').equals(appId).first()
  if (!entry) throw new Error('Application not found')
  await applyStatus(entry, status, todayISO(), 'Assigned by you')
  await db.unmatched.delete(messageId)
}

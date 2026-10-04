// Gmail status sync (read-only). Every 2 hours: search the last 30 days of mail
// from ATS domains and companies in the sheet, match each new email to one
// application, classify it, and move the Status column forward. Email content is
// read in memory only; just the resulting status and date are kept.
import type { AppliedEntry, AppStatus, StatusEvent } from '@/shared/types'
import { uid } from '@/shared/defaults'
import { todayISO } from '@/shared/text'
import { buildQuery, classifyEmail, matchApplication, nextStatus } from '@/core/gmail/rules'
import { db } from '@/lib/db'
import { getSettings, updateSettings } from '@/lib/repo'
import { gfetch, SCOPES } from './google'
import { writeStatus } from './sheets'
import { enqueue } from './queue'
import { classifyEmailAi } from './ai/tasks'
import { offscreen } from './ai/router'

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
  if (plain?.body?.data) return b64url(plain.body.data)
  const html = findPart(m.payload, 'text/html')
  if (html?.body?.data) {
    const r = await offscreen<{ text?: string }>({ type: 'html2text', html: b64url(html.body.data) })
    return r?.text ?? ''
  }
  return ''
}

async function listIds(q: string, max = 300): Promise<string[]> {
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
}

let syncing = false

export async function syncGmail(): Promise<SyncResult> {
  const settings = await getSettings()
  if (!settings.gmailEnabled || syncing) return { scanned: 0, changed: 0, unmatched: 0 }
  syncing = true
  try {
    const cutoff = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10)
    const apps = (await db.applied.toArray()).filter((a) => !a.dateApplied || a.dateApplied >= cutoff)
    if (!apps.length) return { scanned: 0, changed: 0, unmatched: 0 }

    const ids = await listIds(buildQuery(apps.map((a) => a.company)))
    const seen = new Set((await db.emails.bulkGet(ids)).filter(Boolean).map((r) => r!.id))
    const fresh = ids.filter((id) => !seen.has(id)).reverse() // oldest first, so statuses advance in order
    let changed = 0
    let unmatched = 0

    for (const id of fresh) {
      const m = await gfetch<Message>(`${API}/messages/${id}?format=full`, S)
      const email = { from: header(m, 'From'), subject: header(m, 'Subject'), body: await bodyText(m) }
      const date = todayISO(new Date(Number(m.internalDate)))
      const open = await db.applied.toArray()
      const { entry, candidates } = matchApplication(email, open)
      let status = classifyEmail(email.subject, email.body)

      if (!entry) {
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
            changed++
          } else if (t.kind === 'offer') {
            await applyStatus(entry, 'Offer', date, 'Offer received. Your decision; nothing was done.', 'offer')
            changed++
          } else if (t.kind === 'conflict') {
            await addEvent({ appId: entry.appId, company: entry.company, title: entry.title, from: entry.status, to: status, at: Date.now(), kind: 'conflict', note: t.reason })
          } else if (!entry.firstReply) {
            await db.applied.update(entry.key, { firstReply: date })
          }
        }
      }
      await db.emails.put({ id, at: Date.now() })
    }
    await updateSettings({ lastGmailSync: Date.now() })
    return { scanned: fresh.length, changed, unmatched }
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

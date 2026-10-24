// Queue and Gmail fixes, with the Google calls faked.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installChrome, resetStores } from './chromeMock'
import type { AppliedEntry, JobRecord } from '@/shared/types'
import { normalizeCompany } from '@/shared/text'

const alarms: { name: string; info: unknown }[] = []
installChrome({ alarms: { create: async (name: string, info: unknown) => void alarms.push({ name, info }) } })

const sheet = { ids: new Set<string>(), appended: [] as string[], statuses: [] as unknown[], missing: new Set<string>() }

vi.mock('@/background/sheets', () => {
  class MissingRowError extends Error {}
  return {
    MissingRowError,
    sheetAppIds: async () => new Set(sheet.ids),
    refreshApplied: async () => [],
    appendRecord: async (r: JobRecord) => {
      sheet.appended.push(r.appId)
      sheet.ids.add(r.appId)
      return 2
    },
    writeStatus: async (u: { appId: string }) => {
      if (sheet.missing.has(u.appId)) throw new MissingRowError(u.appId)
      sheet.statuses.push(u)
    },
  }
})

const mail: Record<string, { from: string; subject: string; body: string; date: string }> = {}
/** Message IDs Gmail refuses with its per-minute rate limit. */
const limited = new Set<string>()
vi.mock('@/background/google', () => {
  class HttpError extends Error {
    constructor(public status: number, message: string) {
      super(message)
    }
  }
  return {
  SCOPES: { drive: 'd', gmail: 'g' },
  NotConnectedError: class extends Error {},
  HttpError,
  gfetch: async (url: string) => {
    if (url.includes('/messages?')) return { messages: Object.keys(mail).map((id) => ({ id })) }
    const id = url.match(/messages\/([^?]+)/)![1]
    if (limited.has(id)) throw new HttpError(403, "Google API 403: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'")
    const m = mail[id]
    // UTF-8, like Gmail (emails can carry emoji).
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(m.body))).replace(/\+/g, '-').replace(/\//g, '_')
    return {
      id,
      internalDate: String(new Date(m.date + 'T12:00:00').getTime()),
      payload: { mimeType: 'text/plain', body: { data: b64 }, headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }] },
    }
  },
  }
})
vi.mock('@/background/ai/tasks', () => ({ classifyEmailAi: async () => null }))
vi.mock('@/background/ai/router', () => ({ offscreen: async () => ({}) }))

const { db } = await import('@/lib/db')
const { enqueue, flushQueue } = await import('@/background/queue')
const { syncGmail } = await import('@/background/gmail')
const { updateSettings } = await import('@/lib/repo')

const rec = (appId: string): JobRecord => ({
  appId, dateApplied: '2026-10-19', company: 'Globex', title: 'Analyst', location: '', jobId: 'R1', ats: 'Greenhouse', url: '', resumeUsed: '',
  matchScore: '', verdict: '', redFlags: '', status: 'Applied', firstReply: '', lastStatusChange: '2026-10-19', notes: '',
})

beforeEach(async () => {
  resetStores()
  await Promise.all(db.tables.map((t) => t.clear()))
  sheet.ids.clear()
  sheet.appended = []
  sheet.statuses = []
  sheet.missing.clear()
  for (const k of Object.keys(mail)) delete mail[k]
  limited.clear()
  alarms.length = 0
})

describe('retry queue', () => {
  it('does not add a row twice when the first write landed but its reply was lost', async () => {
    sheet.ids.add('a1') // it's already in the sheet
    await enqueue('append', rec('a1'), 'network error')
    await enqueue('append', rec('a2'), 'network error')
    await flushQueue()
    expect(sheet.appended).toEqual(['a2'])
    expect(await db.queue.count()).toBe(0)
  })

  it('drops a status update for a row you deleted, instead of retrying forever', async () => {
    sheet.missing.add('gone')
    await enqueue('status', { appId: 'gone', status: 'Interview', firstReply: '', lastStatusChange: '' }, 'x')
    await flushQueue()
    expect(await db.queue.count()).toBe(0)
  })
})

describe('Gmail sync', () => {
  const entry = (o: Partial<AppliedEntry>): AppliedEntry => ({
    key: 'globex|r2', appId: 'new', company: 'Globex', companyNorm: 'globex', title: 'Data Analyst', jobId: 'R2', url: '',
    dateApplied: '2026-10-15', status: 'Applied', firstReply: '', lastStatusChange: '2026-10-15', ...o,
  })

  it('ignores an email sent before you applied', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(entry({}))
    mail.m1 = { from: 'jobs@globex.com', subject: 'Your application', body: 'Unfortunately, we decided to move forward with other candidates.', date: '2026-10-01' }
    await syncGmail()
    expect((await db.applied.get('globex|r2'))!.status).toBe('Applied')
  })

  it('still applies emails sent after you applied', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(entry({}))
    mail.m2 = { from: 'jobs@globex.com', subject: 'Interview', body: "We'd like to schedule a call with you.", date: '2026-10-18' }
    await syncGmail()
    expect((await db.applied.get('globex|r2'))!.status).toBe('Interview')
  })

  it('writes the first reply date to the sheet even when the status does not change', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(entry({ status: 'Interview' }))
    mail.m3 = { from: 'jobs@globex.com', subject: 'Thanks', body: 'We have received your application.', date: '2026-10-16' }
    await syncGmail()
    expect((await db.applied.get('globex|r2'))!.firstReply).toBe('2026-10-16')
    expect(sheet.statuses).toEqual([expect.objectContaining({ appId: 'new', firstReply: '2026-10-16', status: 'Interview' })])
  })

  // Shapes of the real acknowledgment emails that never updated anything.
  const real = (company: string, title: string, o: Partial<AppliedEntry> = {}) =>
    entry({ key: company, appId: company, company, companyNorm: normalizeCompany(company), title, jobId: '', ...o })

  it('reads dates the sheet returns as serial numbers (46317 is 2026-10-22)', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(real('Sierra', 'Software Engineer, Agent (New Grad)', { dateApplied: '46317' }))
    mail.s1 = { from: 'Sierra <no-reply@ashbyhq.com>', subject: 'Thanks for your application', body: "Hi Maazin, Thank you for applying for the Software Engineer, Agent (New Grad) role at Sierra. We've received your application.", date: '2026-10-22' }
    await syncGmail()
    expect((await db.applied.get('Sierra'))!.status).toBe('Received')
  })

  it('matches ATS mail by the company in the sender address and by squashed names', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.bulkPut([
      real('Flatpay ApS ', 'Data Engineer', { dateApplied: '2026-10-22' }),
      real('Scaleai', 'Software Engineer', { dateApplied: '2026-10-22' }),
      real('Infor Careers', 'Java Software Engineer, Associate', { dateApplied: '2026-10-22' }),
      real('TP ICAP', 'Engineer C# (Full Stack)', { dateApplied: '2026-10-19' }),
    ])
    mail.f = { from: 'Natalie <natalie.feier@flatpay.teamtailor-mail.com>', subject: 'Thanks for your application', body: "Hi Maazin, Thanks for applying for the Data Engineer role 🚀 We've received your application and will review it.", date: '2026-10-22' }
    mail.sc = { from: 'no-reply@us.greenhouse-mail.io', subject: 'Thank you for applying to Scale AI', body: 'Maazin, Thanks for applying to Scale AI. Your application has been received.', date: '2026-10-22' }
    mail.i = { from: 'Infor <no-reply.infor@pinpoint.email>', subject: 'Thank you for applying!', body: 'Many thanks for taking the time to apply for the Java Software Engineer, Associate position here at Infor. Your application will be reviewed shortly.', date: '2026-10-22' }
    mail.t = { from: 'tp@myworkday.com', subject: 'Thank you for applying!', body: 'Dear Maazin, Thank you for your interest in TP ICAP. We have received your application for the Engineer C# (Full Stack) role.', date: '2026-10-19' }
    await syncGmail()
    for (const k of ['Flatpay ApS ', 'Scaleai', 'Infor Careers', 'TP ICAP']) expect((await db.applied.get(k))!.status, k).toBe('Received')
  })

  it("stops at Gmail's rate limit, keeps its progress and finishes on the retry", async () => {
    await updateSettings({ gmailEnabled: true, gmailRulesVersion: 1 })
    await db.applied.bulkPut([real('Wayve', 'Software Engineer', { dateApplied: '2026-10-22' }), real('Mujin', 'Software Engineer', { dateApplied: '2026-10-22' })])
    // Listed newest first; processed oldest first (mu, then wa).
    mail.wa = { from: 'no-reply@ashbyhq.com', subject: 'Wayve | Thanks for Applying!', body: 'Thank you for applying to Wayve!', date: '2026-10-22' }
    mail.mu = { from: 'no-reply@hire.lever.co', subject: 'Thank you for your application to Mujin', body: 'We have successfully received your application.', date: '2026-10-22' }
    limited.add('wa')
    const first = await syncGmail()
    expect(first.limited).toBe(true)
    expect((await db.applied.get('Mujin'))!.status).toBe('Received')
    expect((await db.applied.get('Wayve'))!.status).toBe('Applied')
    expect(alarms).toEqual([{ name: 'zipply-gmail', info: { delayInMinutes: 2, periodInMinutes: 120 } }])
    // The retry: no rescan from scratch, just the rest.
    limited.clear()
    await db.applied.update('Mujin', { status: 'Applied' })
    await syncGmail()
    expect((await db.applied.get('Wayve'))!.status).toBe('Received')
    expect((await db.applied.get('Mujin'))!.status).toBe('Applied')
  })

  it('looks again at emails an older version marked as done without a match', async () => {
    await updateSettings({ gmailEnabled: true, gmailRulesVersion: 1 })
    await db.applied.put(real('Wayve', 'Software Engineer', { dateApplied: '2026-10-22' }))
    mail.w = { from: 'no-reply@ashbyhq.com', subject: 'Wayve | Thanks for Applying!', body: 'Hi Maazin, Thank you for applying to Wayve!', date: '2026-10-22' }
    await db.emails.put({ id: 'w', at: Date.now() })
    await db.unmatched.put({ messageId: 'w', reason: 'No matching application', candidates: [], at: Date.now() })
    await syncGmail()
    expect((await db.applied.get('Wayve'))!.status).toBe('Received')
    expect(await db.unmatched.count()).toBe(0)
    // Only once: the next sync doesn't redo it.
    await db.applied.update('Wayve', { status: 'Applied' })
    await syncGmail()
    expect((await db.applied.get('Wayve'))!.status).toBe('Applied')
  })
})

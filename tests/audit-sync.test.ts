// Queue and Gmail fixes, with the Google calls faked.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installChrome, resetStores } from './chromeMock'
import type { AppliedEntry, JobRecord } from '@/shared/types'

installChrome()

const sheet = { ids: new Set<string>(), appended: [] as string[], statuses: [] as unknown[], missing: new Set<string>() }

vi.mock('@/background/sheets', () => {
  class MissingRowError extends Error {}
  return {
    MissingRowError,
    sheetAppIds: async () => new Set(sheet.ids),
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
vi.mock('@/background/google', () => ({
  SCOPES: { drive: 'd', gmail: 'g' },
  NotConnectedError: class extends Error {},
  gfetch: async (url: string) => {
    if (url.includes('/messages?')) return { messages: Object.keys(mail).map((id) => ({ id })) }
    const id = url.match(/messages\/([^?]+)/)![1]
    const m = mail[id]
    const b64 = btoa(m.body).replace(/\+/g, '-').replace(/\//g, '_')
    return {
      id,
      internalDate: String(new Date(m.date + 'T12:00:00').getTime()),
      payload: { mimeType: 'text/plain', body: { data: b64 }, headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }] },
    }
  },
}))
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
})

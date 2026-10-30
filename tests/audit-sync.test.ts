// Queue and Gmail fixes, with the Google calls faked.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installChrome, resetStores } from './chromeMock'
import type { AppliedEntry, JobRecord } from '@/shared/types'
import { normalizeCompany } from '@/shared/text'

const alarms: { name: string; info: unknown }[] = []
installChrome({ alarms: { create: async (name: string, info: unknown) => void alarms.push({ name, info }) } })

const sheet = { ids: new Set<string>(), appended: [] as string[], statuses: [] as unknown[], missing: new Set<string>(), removed: 0, before: undefined as string | undefined }

vi.mock('@/background/sheets', () => {
  class MissingRowError extends Error {}
  return {
    MissingRowError,
    FROM_EMAIL: 'Added from your email',
    removeEmailRows: async (before?: string) => {
      sheet.removed++
      sheet.before = before
      return 0
    },
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

const mail: Record<string, { from: string; subject: string; body: string; date: string; to?: string; labeled?: boolean; sent?: boolean }> = {}
const listed: string[] = []
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
    if (url.includes('/labels')) return { labels: [{ name: 'Applications/Applied', type: 'user' }, { name: 'INBOX', type: 'system' }] }
    if (url.includes('/messages?')) {
      listed.push(url)
      const byLabel = decodeURIComponent(url).includes('label:applications-applied')
      return { messages: Object.keys(mail).filter((id) => (byLabel ? mail[id].labeled : !mail[id].sent)).map((id) => ({ id })) }
    }
    const id = url.match(/messages\/([^?]+)/)![1]
    if (limited.has(id)) throw new HttpError(403, "Google API 403: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'")
    const m = mail[id]
    // UTF-8, like Gmail (emails can carry emoji).
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(m.body))).replace(/\+/g, '-').replace(/\//g, '_')
    return {
      id,
      internalDate: String(new Date(m.date + 'T12:00:00').getTime()),
      labelIds: m.sent ? ['SENT'] : ['INBOX'],
      payload: { mimeType: 'text/plain', body: { data: b64 }, headers: [{ name: 'From', value: m.from }, { name: 'To', value: m.to ?? 'me@example.com' }, { name: 'Subject', value: m.subject }] },
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
  sheet.removed = 0
  for (const k of Object.keys(mail)) delete mail[k]
  limited.clear()
  listed.length = 0
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

  it('a saved title of "Apply" no longer ties with the real company', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.bulkPut([
      real('Infor Careers', 'Apply', { dateApplied: '2026-10-22' }),
      real('Scaleai', 'Software Engineer', { dateApplied: '2026-10-22' }),
      real('Cleoindia', 'SDET', { dateApplied: '2026-10-22' }),
      real('Epeconsulting', 'Business Analyst', { dateApplied: '2026-10-22' }),
    ])
    mail.sc = { from: 'no-reply@us.greenhouse-mail.io', subject: 'Thank you for applying to Scale AI', body: 'Maazin, Thanks for applying to Scale AI. Your application has been received and we will review it right away.', date: '2026-10-22' }
    mail.cl = { from: 'no-reply@us.greenhouse-mail.io', subject: 'Thank you for applying to Cleo (India)', body: 'Maazin, Thanks for applying to Cleo (India) . Your application has been received.', date: '2026-10-22' }
    mail.ep = { from: 'epeconsulting+autoreply@talent.icims.com', subject: 'Thank you for applying at Electric Power Engineers', body: 'Thank you for your recent application to the Business Analyst position. To apply for other roles, visit our site.', date: '2026-10-22' }
    await syncGmail()
    for (const k of ['Scaleai', 'Cleoindia', 'Epeconsulting']) expect((await db.applied.get(k))!.status, k).toBe('Received')
    expect((await db.applied.get('Infor Careers'))!.status).toBe('Applied')
  })

  it("never matches on a role title alone (another company's rejection)", async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(real('Axle Energy', 'Software Engineer', { dateApplied: '2026-10-22', status: 'Received' }))
    mail.z = { from: 'JD <jd@zanskar.us>', subject: 'Maazin - Thank you for your interest', body: 'Thank you sincerely for your interest in the Full-Stack Software Engineer, Platform Data role at Zanskar. Unfortunately, we have decided to move forward with other candidates.', date: '2026-10-23' }
    await syncGmail()
    expect((await db.applied.get('Axle Energy'))!.status).toBe('Received')
  })

  it('moves both rows when the same job was logged twice, and reads German acknowledgments', async () => {
    await updateSettings({ gmailEnabled: true })
    const title = 'Softwareentwickler (m/w/d) für KI & Automatisierung - in Essen'
    await db.applied.bulkPut([
      real('KB Marketing GmbH', title, { key: 'kb1', appId: 'kb1', jobId: '2791783', dateApplied: '2026-10-22' }),
      real('KB Marketing GmbH', title, { key: 'kb2', appId: 'kb2', jobId: '2791785', dateApplied: '2026-10-22' }),
    ])
    mail.kb = { from: 'job.kcm8v.fpsouc.kbmarketinggmbh1@recruitee-mail.com', subject: 'Eingangsbestätigung deiner Bewerbung bei der KB Marketing GmbH', body: 'Vielen Dank für deine Bewerbung! Um deine Bewerbung vollständig abzuschließen, tue bitte folgendes.', date: '2026-10-22' }
    await syncGmail()
    expect((await db.applied.get('kb1'))!.status).toBe('Received')
    expect((await db.applied.get('kb2'))!.status).toBe('Received')
  })

  it('accepts an acknowledgment from a day or two before an application logged late', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(real('Affirm', 'Software Engineer I, Fullstack (Search)', { dateApplied: '2026-10-22' }))
    mail.af = { from: 'no-reply@us.greenhouse-mail.io', subject: 'We’ve received your application for Software Engineer I, Fullstack (Search) at Affirm', body: 'Hi Maazin, Thank you for applying for the Software Engineer I, Fullstack (Search) position at Affirm!', date: '2026-10-20' }
    await syncGmail()
    expect((await db.applied.get('Affirm'))!.status).toBe('Received')
  })

  it("stops at Gmail's rate limit, keeps its progress and finishes on the retry", async () => {
    await updateSettings({ gmailEnabled: true, gmailRulesVersion: 3 })
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
  listed.length = 0
    await db.applied.update('Mujin', { status: 'Applied' })
    await syncGmail()
    expect((await db.applied.get('Wayve'))!.status).toBe('Received')
    expect((await db.applied.get('Mujin'))!.status).toBe('Applied')
  })

  it('looks again at emails an older version marked as done without a match', async () => {
    await updateSettings({ gmailEnabled: true, gmailRulesVersion: 3 })
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

describe('applications found in email', () => {
  const existing = (o: Partial<AppliedEntry>): AppliedEntry => ({
    key: 'k', appId: 'a', company: 'Tripactions', companyNorm: 'tripactions', title: 'Software Engineer, New Grad', jobId: '', url: '', ats: 'Greenhouse',
    dateApplied: '2026-10-27', status: 'Applied', firstReply: '', lastStatusChange: '2026-10-27', ...o,
  })
  const rows = async () => (await db.applied.toArray()).sort((a, b) => a.company.localeCompare(b.company))

  it('adds a rejection for an application the sheet never had, with no applied date', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(existing({}))
    mail.r1 = {
      from: 'Branden Smith <branden@contextlabs.com>',
      subject: 'Thank you for your interest in Context Labs',
      body: 'Hi Maazin,\nAlthough your background is impressive, we regret to inform you that we have decided to pursue other candidates for the position at this time.',
      date: '2026-10-27',
    }
    const res = await syncGmail()
    expect(res.added).toBe(1)
    const ctx = (await rows()).find((r) => r.company === 'Context Labs')!
    expect(ctx).toMatchObject({ status: 'Rejected', dateApplied: '', lastStatusChange: '2026-10-27' })
    expect(sheet.appended).toHaveLength(1)
  })

  it('a confirmation adds it, and the later rejection moves that row', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(existing({}))
    mail.c1 = { from: 'Boosters Hiring Team <no-reply@ashbyhq.com>', subject: 'Thanks for applying | Boosters | Trainee Data Analyst', body: 'Thank you for applying to the Trainee Data Analyst role at Boosters.', date: '2026-10-22' }
    mail.c2 = { from: 'Boosters Hiring Team <no-reply@ashbyhq.com>', subject: 'Update on your application to Boosters', body: 'Unfortunately, we have decided to move forward with other candidates.', date: '2026-10-23' }
    await syncGmail()
    const b = (await rows()).filter((r) => /boosters/i.test(r.company))
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ status: 'Rejected', dateApplied: '2026-10-22' })
  })

  it('keeps each application found in email apart, so a later rejection finds its own', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(existing({}))
    mail.a1 = { from: 'Clay <no-reply@ashbyhq.com>', subject: 'Thanks for applying to Clay!', body: 'Thank you for your application.', date: '2026-10-20' }
    mail.a2 = { from: 'Harvey <no-reply@greenhouse-mail.io>', subject: 'Thank You for Applying to Harvey', body: 'We received your application.', date: '2026-10-21' }
    mail.a3 = { from: 'Clay <no-reply@ashbyhq.com>', subject: 'Your application to Clay', body: 'Unfortunately, we will not be moving forward with your application.', date: '2026-10-24' }
    const res = await syncGmail()
    expect(res.added).toBe(2)
    const byCo = Object.fromEntries((await rows()).map((r) => [r.company, r.status]))
    expect(byCo).toMatchObject({ Clay: 'Rejected', Harvey: 'Received', Tripactions: 'Applied' })
  })

  it("adds a rejection even when another job that week has the same title", async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(existing({ title: 'Software Engineer' }))
    mail.p1 = { from: 'P&G Workday System <pg@myworkday.com>', subject: 'P&G Careers – Application Outcome', body: 'We regret to inform you that you have not been chosen for the Software Engineer position.', date: '2026-10-27' }
    expect((await syncGmail()).added).toBe(1)
  })

  it('removes what the first version added before finding it again', async () => {
    await updateSettings({ gmailEnabled: true, gmailRulesVersion: 6 })
    await db.applied.put(existing({}))
    await syncGmail()
    expect(sheet.removed).toBe(1)
    await updateSettings({ gmailRulesVersion: 10 })
    await syncGmail()
    expect(sheet.removed).toBe(2)
    await updateSettings({ gmailRulesVersion: 5 })
    await syncGmail()
    expect(sheet.removed).toBe(2)
  })

  it("doesn't add a company the sheet has under another name, or a webinar", async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(existing({}))
    mail.n1 = { from: 'Navan <no-reply@us.greenhouse-mail.io>', subject: 'Thank you for applying to Navan', body: 'Thank you for applying for the Software Engineer, New Grad role.', date: '2026-10-27' }
    mail.w1 = { from: 'Carnegie Mellon <events@cmu.edu>', subject: 'Grad School Insights Webinar', body: 'Thank you for your interest! Your graduate application questions answered.', date: '2026-10-21' }
    mail.h1 = { from: 'Handshake <hello@notifications.joinhandshake.com>', subject: "Application sent to Tech Comm — here's what's next", body: 'Thank you for applying. Your application was sent.', date: '2026-10-26' }
    const res = await syncGmail()
    expect(res.added ?? 0).toBe(0)
    expect(await db.applied.count()).toBe(1)
  })
})

describe('trash and your Applied label', () => {
  const tracked = (o: Partial<AppliedEntry> = {}): AppliedEntry => ({
    key: 'seb', appId: 'seb', company: 'SEB', companyNorm: 'seb', title: 'Cloud Developer', jobId: '', url: '', ats: 'Lever',
    dateApplied: '2026-10-22', status: 'Received', firstReply: '', lastStatusChange: '2026-10-22', ...o,
  })

  it('searches the trash, where rejections get deleted, but not spam', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(tracked())
    mail.t1 = { from: 'SEB <no-reply@lever.co>', subject: 'With reference to your application at SEB', body: 'Unfortunately, we have decided to move forward with other candidates.', date: '2026-10-27' }
    await syncGmail()
    expect(listed.every((u) => u.includes('includeSpamTrash=true'))).toBe(true)
    expect(listed.every((u) => decodeURIComponent(u).includes('-in:spam'))).toBe(true)
    expect((await db.applied.get('seb'))!.status).toBe('Rejected')
  })

  it('adds what is in your Applied label: a confirmation in Spanish, and an application you emailed', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(tracked())
    mail.l1 = { from: 'Factorial <noreply@nologin.es>', subject: 'Gracias por su solicitud', body: 'Hola Maazin, muchas gracias por aplicar para el puesto AI Engineer en NOLOGIN CONSULTING SLU.', date: '2026-10-27', labeled: true }
    mail.l2 = { from: 'Maazin <me@example.com>', to: 'careers@serpapi.com', subject: 'Junior Fullstack Engineer - Maazin Shaikh', body: 'Please consider my application.', date: '2026-10-27', labeled: true, sent: true }
    // Not in the label and not readable: left alone.
    mail.l3 = { from: 'Someone <hi@acme.com>', subject: 'Gracias por su solicitud', body: 'Hola.', date: '2026-10-27' }
    const res = await syncGmail()
    expect(res.added).toBe(2)
    const rows = Object.fromEntries((await db.applied.toArray()).map((r) => [r.company, r.status]))
    expect(rows).toMatchObject({ Nologin: 'Received', Serpapi: 'Applied', SEB: 'Received' })
    expect(rows.Acme).toBeUndefined()
  })

  it('never changes a status from an email you sent', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(tracked())
    mail.s1 = { from: 'Maazin <me@example.com>', to: 'jobs@seb.se', subject: 'Following up on my interview', body: "I'd like to schedule a call about the next round.", date: '2026-10-27', labeled: true, sent: true }
    await syncGmail()
    expect((await db.applied.get('seb'))!.status).toBe('Received')
  })
})

describe('how far back applications are found', () => {
  it('starts from the month before the first application Zipply logged, not one it found', async () => {
    const { db: d } = await import('@/lib/db')
    await updateSettings({ gmailEnabled: true, gmailRulesVersion: 12 })
    await d.applied.bulkPut([
      { key: 'z', appId: 'z', company: 'Luminai', companyNorm: 'luminai', title: 'Engineer', jobId: '', url: '', dateApplied: '2026-10-19', status: 'Received', firstReply: '', lastStatusChange: '2026-10-19' },
      { key: 'e', appId: 'e', company: 'Old Co', companyNorm: 'old co', title: '', jobId: '', url: '', dateApplied: '2026-09-02', status: 'Received', firstReply: '', lastStatusChange: '2026-09-02', fromEmail: true },
    ])
    await syncGmail()
    // Oct 19 less two weeks is Oct 5: from Oct 1. What 12 found before then goes.
    expect(sheet.before).toBe('2026-10-01')
    const { getSettings } = await import('@/lib/repo')
    expect((await getSettings()).gmailDiscoverSince).toBe('2026-10-01')
  })
})

describe('sync places emails itself; only real puzzles are yours', () => {
  const row = (o: Partial<AppliedEntry>): AppliedEntry => ({
    key: o.appId!, appId: 'x', company: 'Acme', companyNorm: 'acme', title: '', jobId: '', url: '', dateApplied: '2026-10-10', status: 'Received', firstReply: '', lastStatusChange: '2026-10-10', ...o,
  })
  const review = async () => (await db.unmatched.toArray()).map((u) => u.reason)

  it('a rejection from a company with two applications, naming neither role, closes the latest', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.bulkPut([
      row({ appId: 'old', key: 'old', title: 'Data Analyst', dateApplied: '2026-10-05' }),
      row({ appId: 'new', key: 'new', title: 'Software Engineer', dateApplied: '2026-10-12' }),
    ])
    mail.r = { from: 'Acme Careers <jobs@acme.com>', subject: 'Your application to Acme', body: 'Unfortunately, we have decided to move forward with other candidates.', date: '2026-10-20' }
    await syncGmail()
    expect((await db.applied.get('new'))!.status).toBe('Rejected')
    expect((await db.applied.get('old'))!.status).toBe('Received')
    expect(await review()).toEqual([])
  })

  it('leaves acknowledgments and unreadable newsletters out of review, but asks about an unreadable maybe-decision', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.put(row({ appId: 'a', key: 'a', title: 'Engineer' }))
    // An acknowledgment from a mailing service that names no employer: nothing to do.
    mail.ack = { from: 'Hiring <no-reply@kajabimail.net>', subject: 'Hello', body: 'We have received your application.', date: '2026-10-15' }
    // From the company but about nothing: a newsletter.
    mail.news = { from: 'Acme <news@acme.com>', subject: 'Acme monthly', body: 'Our product launch is live.', date: '2026-10-16' }
    await syncGmail()
    expect(await review()).toEqual([])
    // Unreadable, yet it might be a decision: that one is yours.
    mail.maybe = { from: 'Acme <jobs@acme.com>', subject: 'About our decision', body: 'We will share more soon.', date: '2026-10-17' }
    await syncGmail()
    expect((await db.applied.get('a'))!.status).toBe('Received')
    expect(await review()).toEqual(['Couldn’t tell what this email means'])
  })

  it('still asks when a decision could be for either of two different companies', async () => {
    await updateSettings({ gmailEnabled: true })
    await db.applied.bulkPut([
      row({ appId: 'p', key: 'p', company: 'Pine', companyNorm: 'pine', title: 'Analyst' }),
      row({ appId: 'q', key: 'q', company: 'Quill', companyNorm: 'quill', title: 'Analyst' }),
    ])
    mail.both = { from: 'Talent <talent@jobsboard.example>', subject: 'Pine and Quill update', body: 'Unfortunately, we will not be moving forward with your application.', date: '2026-10-20' }
    await syncGmail()
    expect(await review()).toEqual(['Matches more than one application'])
  })
})

// Service worker: talks to Google, runs AI calls, logs submissions and keeps
// per-tab state. No server; data stays in this browser and your Google account.
import type { AppStatus, Posting } from '@/shared/types'
import { normalizeCompany } from '@/shared/text'
import { canonicalUrl } from '@/core/score/applied'
import type { ContentToBg, FillContext, FrameInfo, JobContext, PageToBg } from '@/shared/messages'
import { LockedError } from '@/lib/keys'
import { getAnswerBank, getProfile, getResume, getSettings, listResumes, saveAnswer, markAnswerUsed, updateSettings } from '@/lib/repo'
import { db } from '@/lib/db'
import { session } from '@/lib/store'
import { aiReady } from './ai/router'
import { coverLetter, draftAnswer, mapFields, tailoringTips } from './ai/tasks'
import { getToken, NotConnectedError, SCOPES, signOut, userEmail } from './google'
import { ensureSheet, refreshApplied } from './sheets'
import { flushQueue, queueSize } from './queue'
import { bareContext, logJob } from './log'
import { assignEmail, messageSummary, syncGmail } from './gmail'

const QUEUE_ALARM = 'zipply-queue'
const GMAIL_ALARM = 'zipply-gmail'

// ---------- Lifecycle ----------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'profile', title: 'Profile', contexts: ['action'] })
  })
  await chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: 15 })
  await chrome.alarms.create(GMAIL_ALARM, { periodInMinutes: 120, delayInMinutes: 1 })
  if (reason === 'install') await chrome.runtime.openOptionsPage()
})

chrome.runtime.onStartup.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  await backgroundRefresh()
})

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'profile') chrome.runtime.openOptionsPage()
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === QUEUE_ALARM) await flushQueue().catch(() => undefined)
  if (alarm.name === GMAIL_ALARM) await syncGmail().catch((e) => console.warn('[zipply] gmail sync', e))
})

async function backgroundRefresh() {
  const s = await getSettings()
  if (!s.googleEmail) return
  await flushQueue().catch(() => undefined)
  await refreshApplied().catch(() => undefined)
}

// ---------- Per-tab state ----------

const framesKey = (tabId: number) => `frames:${tabId}`
const jobKey = (tabId: number) => `job:${tabId}`

async function getFrames(tabId: number): Promise<FrameInfo[]> {
  return (await session.get<FrameInfo[]>(framesKey(tabId))) ?? []
}

export async function getJob(tabId: number): Promise<JobContext | null> {
  return (await session.get<JobContext>(jobKey(tabId))) ?? null
}

async function setJob(tabId: number, job: JobContext | null) {
  if (job) await session.set(jobKey(tabId), job)
  else await session.remove(jobKey(tabId))
}

async function updateBadge(tabId: number) {
  const frames = await getFrames(tabId)
  const on = frames.some((f) => f.fields >= 3)
  await chrome.action.setBadgeText({ tabId, text: on ? ' ' : '' }).catch(() => undefined)
  if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#16a34a' }).catch(() => undefined)
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await session.remove(framesKey(tabId))
  await session.remove(jobKey(tabId))
})

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'loading' && info.url) {
    // New page: frames re-register themselves. The job context survives so a
    // confirmation page that follows a submit can still be logged.
    await session.remove(framesKey(tabId))
    await updateBadge(tabId)
  }
})

// ---------- Messages ----------

type Reply = (r: unknown) => void

chrome.runtime.onMessage.addListener((msg: (ContentToBg | PageToBg) & { target?: string }, sender, reply: Reply) => {
  if (msg?.target === 'offscreen') return false
  handle(msg, sender)
    .then(reply)
    .catch((e) => {
      console.warn('[zipply]', msg.type, e)
      reply({ error: e instanceof Error ? e.message : String(e), locked: e instanceof LockedError })
    })
  return true
})

async function fillContext(tabId: number | undefined, resumeId: string | null): Promise<FillContext> {
  const [profile, bank, settings, metas] = await Promise.all([getProfile(), getAnswerBank(), getSettings(), listResumes()])
  const job = tabId != null ? await getJob(tabId) : null
  const id = resumeId ?? job?.resumeId ?? metas.find((m) => m.isDefault)?.id ?? metas[0]?.id ?? null
  const r = id ? await getResume(id) : null
  return {
    profile,
    bank,
    resume: r ? { id: r.id, name: r.name, mime: r.mime, data: r.data } : null,
    threshold: settings.fillThreshold,
    autoDraft: settings.autoDraft,
    aiReady: await aiReady(),
    posting: job?.posting ?? null,
  }
}

async function handle(msg: ContentToBg | PageToBg, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id
  switch (msg.type) {
    // ----- from content scripts -----
    case 'frame:status': {
      if (tabId == null) return null
      const frames = (await getFrames(tabId)).filter((f) => f.frameId !== (sender.frameId ?? 0))
      frames.push({ frameId: sender.frameId ?? 0, ats: msg.ats, fields: msg.fields, confirmation: msg.confirmation, url: sender.url ?? '' })
      await session.set(framesKey(tabId), frames)
      await updateBadge(tabId)
      // Remember the posting so a later confirmation page can be logged even if
      // the panel was never opened.
      const p = msg.posting
      if (p && (p.company || p.title) && !msg.confirmation) {
        const job = await getJob(tabId)
        if (!job || !samePosting(job.posting, p)) await setJob(tabId, bareContext(msg.ats, p.url, p))
      }
      return null
    }
    case 'fill:context':
      return fillContext(tabId, msg.resumeId)
    case 'fill:done': {
      if (tabId == null) return null
      const job = await getJob(tabId)
      if (job) await setJob(tabId, { ...job, filledAt: Date.now() })
      return null
    }
    case 'answer:save':
      await saveAnswer({ label: msg.label, answer: msg.answer, fieldKind: msg.fieldKind, host: msg.host, source: msg.source })
      return { ok: true }
    case 'answer:used':
      await markAnswerUsed(msg.id)
      return { ok: true }
    case 'ai:map':
      return { mappings: await mapFields(msg.fields) }
    case 'ai:answer': {
      const job = tabId != null ? await getJob(tabId) : null
      return (await draftAnswer(msg.question, job?.posting ?? null, await getProfile(), msg.maxWords)) ?? { error: 'No AI model available' }
    }
    case 'submit:confirmed': {
      if (tabId == null) return null
      let job = await getJob(tabId)
      if (job?.loggedAppId) return { ok: true, duplicate: true }
      const p = msg.posting
      // Prefer what the confirmation page says if it names a different job.
      if (p && (p.company || p.title) && (!job || (p.jobId && p.jobId !== job.posting.jobId))) job = { ...(job ?? bareContext(msg.ats, msg.url, p)), posting: { ...(job?.posting ?? p), ...stripEmpty(p) } }
      if (!job) return { ok: false, error: 'No job context' }
      const res = await logJob(job)
      if (res.ok && res.appId) await setJob(tabId, { ...job, loggedAppId: res.appId })
      chrome.runtime.sendMessage({ type: 'logged', tabId, result: res }).catch(() => undefined)
      return res
    }

    // ----- from the panel and the Profile page -----
    case 'tab:state':
      return { frames: await getFrames(msg.tabId), job: await getJob(msg.tabId), queue: await queueSize(), settings: await getSettings() }
    case 'job:set': {
      const prev = await getJob(msg.tabId)
      const same = prev && prev.posting.url === msg.job.posting.url
      await setJob(msg.tabId, { ...msg.job, filledAt: same ? prev.filledAt : undefined, loggedAppId: same ? prev.loggedAppId : undefined })
      return { ok: true }
    }
    case 'log:manual': {
      const job = await getJob(msg.tabId)
      if (!job) return { ok: false, error: 'Open the panel on the job page first.' }
      const res = await logJob(job)
      if (res.ok && res.appId) await setJob(msg.tabId, { ...job, loggedAppId: res.appId })
      return res
    }
    case 'ai:cover': {
      const job = await getJob(msg.tabId)
      if (!job) return { error: 'No job found on this page.' }
      return (await coverLetter(job.posting, await getProfile())) ?? { error: 'No AI model available right now.' }
    }
    case 'ai:tips': {
      const job = await getJob(msg.tabId)
      if (!job?.match?.canAdd.length) return { error: 'Nothing to tailor.' }
      const profile = await getProfile()
      const bullets = profile.work.map((w) => `${w.title}, ${w.company}\n${w.description}`).join('\n\n')
      return (await tailoringTips(job.posting, bullets, job.match.canAdd)) ?? { error: 'No AI model available right now.' }
    }
    case 'google:connect': {
      const s = await getSettings()
      await getToken(true, s.gmailEnabled ? [SCOPES.drive, SCOPES.gmail] : [SCOPES.drive])
      const sheetId = await ensureSheet(true)
      const email = (await userEmail()) || 'Connected'
      const settings = await updateSettings({ googleEmail: email })
      await refreshApplied().catch(() => undefined)
      await flushQueue().catch(() => undefined)
      return { email, sheetId, sheetUrl: settings.sheetUrl }
    }
    case 'google:disconnect':
      await signOut()
      await updateSettings({ googleEmail: '', gmailEnabled: false })
      return { ok: true }
    case 'gmail:enable': {
      if (msg.enabled) await getToken(true, [SCOPES.drive, SCOPES.gmail])
      await updateSettings({ gmailEnabled: msg.enabled })
      if (msg.enabled) syncGmail().catch((e) => console.warn('[zipply] gmail sync', e))
      return { ok: true }
    }
    case 'gmail:sync':
      return syncGmail()
    case 'gmail:message':
      return messageSummary(msg.messageId)
    case 'status:assign':
      await assignEmail(msg.messageId, msg.appId, msg.status as AppStatus)
      return { ok: true }
    case 'queue:flush':
      return flushQueue()
    case 'applied:refresh':
      return { rows: (await refreshApplied()).length }
  }
  return null
}

function samePosting(a: Posting, b: Posting): boolean {
  if (a.jobId && b.jobId) return a.jobId === b.jobId && normalizeCompany(a.company) === normalizeCompany(b.company)
  return canonicalUrl(a.url) === canonicalUrl(b.url)
}

function stripEmpty<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null)) as Partial<T>
}

// Surface connection problems as plain errors.
self.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof NotConnectedError) e.preventDefault()
})

// Keep the local cache and queue warm when the worker starts.
void backgroundRefresh()
void db.open()

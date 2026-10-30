// Service worker: talks to Google, runs AI calls, logs submissions and keeps
// per-tab state. No server; data stays in this browser and your Google account.
import type { AppStatus, AtsName, Posting } from '@/shared/types'
import { continuesJob, JOB_TTL, mergePostingInto, samePosting } from '@/core/jobContext'
import { canonicalUrl } from '@/core/score/applied'
import type { ContentToBg, FillContext, FrameInfo, JobContext, PageToBg } from '@/shared/messages'
import { LockedError } from '@/lib/keys'
import { getAnswerBank, getProfile, getResume, getSettings, listResumes, saveAnswer, markAnswerUsed, updateSettings } from '@/lib/repo'
import { clearOldLimitMarks } from '@/lib/usage'
import { db } from '@/lib/db'
import { session } from '@/lib/store'
import { aiReady } from './ai/router'
import { coverLetter, draftAnswer, mapFields, tailoringTips } from './ai/tasks'
import { getToken, NotConnectedError, SCOPES, signOut, userEmail } from './google'
import { ensureSheet, NoSheetError, refreshApplied } from './sheets'
import { flushQueue, queueSize } from './queue'
import { bareContext, logApplied, logJob } from './log'
import { assignEmail, messageSummary, syncGmail } from './gmail'
import { diagnostics, healthChecks } from './health'
import { runChecks } from '@/lib/checks'
import { clearErrors, logError } from '@/lib/errlog'
import { BUILD } from '@/shared/build'
import { isExcluded } from '@/shared/excluded'
import contentScript from '@/content/index.ts?script'
import { reloadIfNewBuildOnDisk } from '@/lib/selfUpdate'

const QUEUE_ALARM = 'zipply-queue'
const GMAIL_ALARM = 'zipply-gmail'
const BUILD_ALARM = 'zipply-build'

// ---------- Lifecycle ----------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'profile', title: 'Profile', contexts: ['action'] })
  })
  await chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: 15 })
  await chrome.alarms.create(GMAIL_ALARM, { periodInMinutes: 120, delayInMinutes: 1 })
  // Unpacked (developer) installs pick up a rebuild within a minute.
  if ((await chrome.management.getSelf()).installType === 'development') await chrome.alarms.create(BUILD_ALARM, { periodInMinutes: 1 })
  // Chrome doesn't put an updated content script into tabs that were already
  // open, and the old copy there can't reach the extension any more.
  if (reason === 'install' || reason === 'update') await injectIntoOpenTabs()
  // Earlier builds took a per-minute AI limit for the daily one and shut the model off until tomorrow.
  if (reason === 'update') {
    const { models, dailyLimits } = await getSettings()
    await clearOldLimitMarks({ [models.flash]: dailyLimits.flash, [models.flashLite]: dailyLimits.flashLite }).catch(() => undefined)
  }
  if (reason === 'install') await chrome.runtime.openOptionsPage()
})

chrome.runtime.onStartup.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  await backgroundRefresh()
  // Also check Gmail when the browser opens, not only every 2 hours.
  await syncGmail().catch((e) => logError('gmail sync', e))
})

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'profile') chrome.runtime.openOptionsPage()
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === BUILD_ALARM) return void (await reloadIfNewBuildOnDisk())
  if (alarm.name === QUEUE_ALARM) await flushQueue().catch((e) => logError('queue', e))
  if (alarm.name === GMAIL_ALARM) await syncGmail().catch((e) => logError('gmail sync', e))
})

async function backgroundRefresh() {
  // Retry queued writes even if sign-in never finished; a silent token works
  // once you've granted access, and otherwise they keep waiting.
  await flushQueue().catch((e) => logError('queue', e))
  const s = await getSettings()
  if (s.googleEmail || s.sheetId) await refreshApplied().catch((e) => {
      if (!(e instanceof NoSheetError)) return logError('refresh sheet', e)
    })
}

/** Put the content script into every open web tab (it skips tabs where a live copy runs). */
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['https://*/*', 'http://*/*'] })
  await Promise.all(
    tabs
      .filter((t) => t.id != null && t.url && !t.discarded && !isExcluded(t.url))
      .map((t) => chrome.scripting.executeScript({ target: { tabId: t.id!, allFrames: true }, files: [contentScript] }).catch(() => undefined)),
  )
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
  if (job) await session.set(jobKey(tabId), { ...job, at: Date.now() })
  else await session.remove(jobKey(tabId))
}

/**
 * A page in this tab shows a posting. If it continues the job you were on
 * (the application form after "Apply", often on another site), keep that job
 * and fill in what's missing; if it's a different posting, it becomes the job.
 */
async function rememberJob(tabId: number, ats: AtsName, p: Posting | null) {
  const prev = await getJob(tabId)
  if (prev && continuesJob(prev, p)) {
    await setJob(tabId, { ...prev, ats: ats !== 'Other' ? ats : prev.ats, posting: mergePostingInto(prev.posting, p), lastUrl: p?.url ?? prev.lastUrl })
    return
  }
  if (p && (p.company || p.title)) await setJob(tabId, { ...bareContext(ats, p.url, p), lastUrl: p.url })
}

// Auto-fill follows the tab, not the site: after you press Fill, the next
// steps fill themselves even when "Apply" moves you to another site.
const autoKey = (tabId: number) => `auto:${tabId}`
/** Auto-fill lasts an hour after you press Fill, then needs a new click. */
const AUTO_TTL = 60 * 60_000
/** A new tab inherits auto-fill only this soon after you turned it on. */
const HANDOFF_MS = 5 * 60_000

async function getAuto(tabId: number): Promise<{ resumeId: string | null } | null> {
  const a = await session.get<{ resumeId: string | null; at: number }>(autoKey(tabId))
  if (!a) return null
  if (Date.now() - a.at > AUTO_TTL) {
    await session.remove(autoKey(tabId))
    return null
  }
  return { resumeId: a.resumeId }
}

async function updateBadge(tabId: number) {
  const frames = await getFrames(tabId)
  const on = frames.some((f) => f.fields >= 3)
  await chrome.action.setBadgeText({ tabId, text: on ? ' ' : '' }).catch(() => undefined)
  if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#16a34a' }).catch(() => undefined)
}

/**
 * You filled a form, then closed the tab or went elsewhere without a confirmed
 * submit. Nothing pops up; the panel lists it under "Since last time" so you
 * can log it or dismiss it.
 */
async function noteIfUnlogged(tabId: number, nextUrl?: string) {
  const job = await getJob(tabId)
  if (!job?.filledAt || job.loggedAppId) return
  if (nextUrl && canonicalUrl(nextUrl) === canonicalUrl(job.posting.url)) return
  // The job context stays: a submit often redirects to a confirmation page at
  // another address, and logging it removes this note again.
  await db.unlogged.put({ id: canonicalUrl(job.posting.url), at: Date.now(), job })
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await noteIfUnlogged(tabId)
  await session.remove(framesKey(tabId))
  await session.remove(jobKey(tabId))
  await session.remove(autoKey(tabId))
})

// "Apply" that opens a new tab: the new tab carries on with the same job.
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id == null || tab.openerTabId == null) return
  const job = await getJob(tab.openerTabId)
  if (!job || (job.at && Date.now() - job.at > JOB_TTL)) return
  await session.set(jobKey(tab.id), { ...job, filledAt: undefined, loggedAppId: undefined, at: Date.now() })
  // Auto-fill only follows a tab opened right after you turned it on, so
  // other jobs you open from the same list don't fill themselves.
  const auto = await session.get<{ resumeId: string | null; at: number }>(autoKey(tab.openerTabId))
  if (auto && Date.now() - auto.at < HANDOFF_MS) await session.set(autoKey(tab.id), auto)
})

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.url) await noteIfUnlogged(tabId, info.url)
  if (info.status === 'loading' && info.url) {
    // New page: frames re-register themselves. The job context survives so a
    // confirmation page that follows a submit can still be logged.
    await session.remove(framesKey(tabId))
    await updateBadge(tabId)
  }
})

// ---------- Messages ----------

/** Listing scores, kept 10 minutes so flipping between jobs is instant. */
const scoreCache = new Map<string, { at: number; result: object }>()

type Reply = (r: unknown) => void

chrome.runtime.onMessage.addListener((msg: (ContentToBg | PageToBg) & { target?: string }, sender, reply: Reply) => {
  if (msg?.target === 'offscreen') return false
  if (msg?.type === 'build') return reply({ build: BUILD }), false
  handle(msg, sender)
    .then(reply)
    .catch((e) => {
      console.warn('[zipply]', msg.type, e)
      if (!(e instanceof LockedError)) void logError(msg.type, e)
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
      const all = await getFrames(tabId)
      const prev = all.find((f) => f.frameId === (sender.frameId ?? 0))
      const frames = all.filter((f) => f !== prev)
      frames.push({ frameId: sender.frameId ?? 0, ats: msg.ats, fields: msg.fields, confirmation: msg.confirmation, url: sender.url ?? '' })
      await session.set(framesKey(tabId), frames)
      await updateBadge(tabId)
      // A new step of a multi-page form (Workday) often keeps the address: tell an open side panel.
      if (prev?.fields !== msg.fields || prev?.confirmation !== msg.confirmation)
        chrome.runtime.sendMessage({ type: 'tab:frames', tabId }).catch(() => undefined)
      // Remember the posting so a later confirmation page can be logged even if
      // the panel was never opened.
      if (!msg.confirmation && (msg.posting || msg.fields > 0)) await rememberJob(tabId, msg.ats, msg.posting)
      return null
    }
    case 'job:seen':
      // A posting page with no form (LinkedIn, Handshake, a careers page): remember it for the "Apply" that follows,
      // and tell an open side panel, since on these sites a new job doesn't load a new page.
      if (tabId != null && (sender.frameId ?? 0) === 0) {
        await rememberJob(tabId, 'Other', msg.posting)
        chrome.runtime.sendMessage({ type: 'tab:job', tabId }).catch(() => undefined)
      }
      return null
    case 'job:applied': {
      // Scored the way the panel scores it, from the panel's own pick when it has one.
      const tabJob = tabId != null ? await getJob(tabId) : null
      const ats: AtsName = /(^|\.)joinhandshake\.com$/.test(new URL(sender.url ?? 'about:blank').hostname) ? 'Handshake' : 'Other'
      return logApplied(msg.jobs, ats, async (p) => {
        if (tabJob?.match && tabJob.posting.jobId === p.jobId) return tabJob
        if (!p.description) return {}
        const c = await runChecks(p, await getProfile())
        const best = c.thin ? null : c.best
        return { match: best, verdict: c.verdict, redFlags: c.redFlags, resumeId: best?.resumeId ?? null, resumeTag: best?.tag || best?.name || '' }
      })
    }
    case 'auto:get':
      return tabId == null ? null : getAuto(tabId)
    case 'auto:set':
      if (tabId != null) await session.set(autoKey(tabId), { resumeId: msg.resumeId, at: Date.now() })
      return null
    case 'auto:arm':
      // "Fill the application when it opens", pressed on a posting page.
      await session.set(autoKey(msg.tabId), { resumeId: msg.resumeId, at: Date.now() })
      return { ok: true }
    case 'auto:clear':
      if (tabId != null) await session.remove(autoKey(tabId))
      return null
    case 'fill:context':
      return fillContext(tabId, msg.resumeId)
    case 'report:update':
      return null
    case 'score:posting': {
      if (!(await getSettings()).listingScores) return { disabled: true }
      // Keyed by your resumes too, so adding, removing or retagging one rescores.
      // And by the description's length: a clipped description read earlier mustn't stick.
      const key = `${msg.posting.url}|${msg.posting.description.length}|${(await listResumes()).map((m) => `${m.id}:${m.tag}`).join(',')}`
      const hit = scoreCache.get(key)
      if (hit && Date.now() - hit.at < 10 * 60_000) return hit.result
      const c = await runChecks(msg.posting, await getProfile())
      const result = {
        score: c.thin ? null : (c.best?.score ?? null),
        verdict: c.verdict.verdict,
        reason: c.thin ? 'Not enough of the description to score' : c.verdict.reason,
        thin: c.thin,
        applied: Boolean(c.applied.alreadyApplied),
        resumes: c.comparison.rows.map((r) => ({ label: r.label, score: r.score })),
      }
      scoreCache.set(key, { at: Date.now(), result })
      return result
    }
    case 'fill:done': {
      if (tabId == null) return null
      const job = await getJob(tabId)
      if (job) await setJob(tabId, { ...job, filledAt: Date.now(), lastUrl: sender.url ?? job.lastUrl })
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
      // On sites without an adapter, a "thank you" page only counts after a fill.
      if (msg.ats === 'Other' && !job.filledAt) return { ok: false, error: 'Not filled by Zipply' }
      const res = await logJob(job)
      if (res.ok && res.appId) await setJob(tabId, { ...job, loggedAppId: res.appId })
      chrome.runtime.sendMessage({ type: 'logged', tabId, result: res }).catch(() => undefined)
      return res
    }

    // ----- from the panel and the Profile page -----
    case 'tab:state':
      return { frames: await getFrames(msg.tabId), job: await getJob(msg.tabId), auto: Boolean(await getAuto(msg.tabId)), queue: await queueSize(), settings: await getSettings() }
    case 'job:set': {
      const prev = await getJob(msg.tabId)
      const same = prev && samePosting(prev.posting, msg.job.posting)
      await setJob(msg.tabId, { ...msg.job, filledAt: same ? prev.filledAt : undefined, loggedAppId: same ? prev.loggedAppId : undefined, lastUrl: prev?.lastUrl })
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
      return (await coverLetter(job.posting, await getProfile())) ?? { error: "The AI couldn't write it just now. Try again in a minute; if it keeps failing, check your Gemini key on the Profile page." }
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
      // Signed in first, so a sheet problem never leaves a "Sign in" button to press again.
      const email = (await userEmail()) || 'Connected'
      await updateSettings({ googleEmail: email })
      const sheetId = await ensureSheet({ create: true, interactive: true })
      await refreshApplied().catch(() => undefined)
      await flushQueue().catch(() => undefined)
      return { email, sheetId, sheetUrl: (await getSettings()).sheetUrl }
    }
    case 'sheet:check':
      // Never creates: clears the warning if the sheet is back (restored from trash).
      return { sheetId: await ensureSheet({ interactive: true }) }
    case 'sheet:create': {
      // You asked for it: replaces a sheet that is gone (never one that still exists).
      const sheetId = await ensureSheet({ force: true, interactive: true })
      await flushQueue().catch(() => undefined)
      return { sheetId, sheetUrl: (await getSettings()).sheetUrl }
    }
    case 'google:disconnect':
      await signOut()
      await updateSettings({ googleEmail: '', gmailEnabled: false })
      return { ok: true }
    case 'gmail:enable': {
      if (msg.enabled) await getToken(true, [SCOPES.drive, SCOPES.gmail])
      await updateSettings({ gmailEnabled: msg.enabled })
      if (msg.enabled) syncGmail().catch((e) => logError('gmail sync', e))
      return { ok: true }
    }
    case 'gmail:sync':
      return syncGmail()
    case 'gmail:message':
      return messageSummary(msg.messageId)
    case 'status:assign':
      await assignEmail(msg.messageId, msg.appId, msg.status as AppStatus)
      return { ok: true }
    case 'log:unlogged': {
      const row = await db.unlogged.get(msg.id)
      if (!row) return { ok: false, error: 'Already handled.' }
      const res = await logJob(row.job)
      if (res.ok) await db.unlogged.delete(msg.id)
      return res
    }
    case 'queue:flush':
      return flushQueue()
    case 'queue:list':
      return (await db.queue.orderBy('createdAt').toArray()).map((q) => ({
        id: q.id,
        op: q.op,
        label: q.op === 'append' ? `${(q.payload as { company: string; title: string }).company}: ${(q.payload as { title: string }).title}` : 'Status update',
        attempts: q.attempts,
        lastError: q.lastError,
      }))
    case 'health':
      return healthChecks()
    case 'diagnostics':
      return diagnostics()
    case 'errors:clear':
      await clearErrors()
      return { ok: true }
    case 'applied:refresh':
      return { rows: (await refreshApplied()).length }
  }
  return null
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

// One check per moving part, for the Profile page's Status panel, plus a
// diagnostics bundle with nothing personal in it.
import type { Settings } from '@/shared/types'
import { db } from '@/lib/db'
import { getGeminiKey, getSettings } from '@/lib/repo'
import { isLocked } from '@/lib/keys'
import { recentErrors, scrub } from '@/lib/errlog'
import { gfetch, getToken, HttpError, NotConnectedError, SCOPES } from './google'
import { nanoAvailability } from './ai/router'

export interface HealthCheck {
  name: 'Profile' | 'Google' | 'Sheet' | 'Gmail' | 'Gemini key' | 'Gemini Nano' | 'Queue'
  /** true works, false needs attention, null off or not applicable */
  ok: boolean | null
  detail: string
}

async function geminiModel(apiKey: string, model: string): Promise<{ ok: boolean; detail: string }> {
  // Reading a model's info doesn't spend generation quota.
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, { headers: { 'x-goog-api-key': apiKey } })
  if (res.ok) return { ok: true, detail: model }
  if (res.status === 404) return { ok: false, detail: `Model "${model}" not found; check the model name` }
  if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, detail: 'Google rejected the key; paste it again from AI Studio' }
  if (res.status === 429) return { ok: true, detail: `${model} (free limit reached for now)` }
  return { ok: false, detail: `Gemini answered ${res.status}` }
}

export async function healthChecks(): Promise<HealthCheck[]> {
  const s: Settings = await getSettings()
  const out: HealthCheck[] = []
  const locked = await isLocked().catch(() => false)
  out.push(locked ? { name: 'Profile', ok: false, detail: 'Locked; enter your passphrase' } : { name: 'Profile', ok: true, detail: 'Unlocked' })

  let google = false
  try {
    await getToken(false, [SCOPES.drive])
    google = true
    out.push({ name: 'Google', ok: true, detail: 'Signed in' })
  } catch (e) {
    out.push({ name: 'Google', ok: false, detail: e instanceof NotConnectedError ? 'Not signed in; click Sign in with Google' : scrub(String((e as Error).message ?? e)) })
  }

  if (!s.sheetId) out.push({ name: 'Sheet', ok: false, detail: google ? 'No sheet yet; it is created when you log your first application' : 'Needs Google first' })
  else if (!google) out.push({ name: 'Sheet', ok: null, detail: 'Needs Google first' })
  else {
    try {
      await gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${s.sheetId}?fields=spreadsheetId`, [SCOPES.drive])
      out.push({ name: 'Sheet', ok: s.sheetReady, detail: s.sheetReady ? 'Reachable' : 'Reachable, setup unfinished; it finishes on the next log' })
    } catch (e) {
      const st = e instanceof HttpError ? e.status : 0
      out.push({ name: 'Sheet', ok: false, detail: st === 404 ? "Can't be found; choose Create a new sheet under Connections" : st === 403 ? 'No access to the saved sheet' : scrub(String((e as Error).message)) })
    }
  }

  if (!s.gmailEnabled) out.push({ name: 'Gmail', ok: null, detail: 'Off' })
  else {
    try {
      await getToken(false, [SCOPES.drive, SCOPES.gmail])
      const ago = s.lastGmailSync ? Math.round((Date.now() - s.lastGmailSync) / 3_600_000) : null
      out.push({ name: 'Gmail', ok: ago === null || ago < 6, detail: ago === null ? 'On, not checked yet' : `Checked ${ago === 0 ? 'within the hour' : `${ago} h ago`}` })
    } catch {
      out.push({ name: 'Gmail', ok: false, detail: 'Gmail access not granted; turn Gmail off and on again' })
    }
  }

  const key = locked ? '' : await getGeminiKey().catch(() => '')
  if (!key) out.push({ name: 'Gemini key', ok: null, detail: 'Not set (drafts and AI mapping are off)' })
  else {
    try {
      const a = await geminiModel(key, s.models.flash)
      const b = a.ok ? await geminiModel(key, s.models.flashLite) : a
      out.push({ name: 'Gemini key', ok: a.ok && b.ok, detail: a.ok && b.ok ? `Works with ${s.models.flash} and ${s.models.flashLite}` : (a.ok ? b : a).detail })
    } catch {
      out.push({ name: 'Gemini key', ok: false, detail: "Couldn't reach Gemini; check your connection" })
    }
  }

  const nano = await nanoAvailability().catch(() => 'unsupported' as const)
  out.push({ name: 'Gemini Nano', ok: nano === 'available' ? true : null, detail: { available: 'Ready', downloadable: 'Downloads on first use', downloading: 'Downloading', unavailable: "This laptop can't run it", unsupported: 'Not in this Chrome' }[nano] })

  const queue = await db.queue.orderBy('createdAt').toArray()
  out.push(
    queue.length
      ? { name: 'Queue', ok: false, detail: `${queue.length} waiting; last error: ${scrub(queue[queue.length - 1].lastError)}` }
      : { name: 'Queue', ok: true, detail: 'Nothing waiting' },
  )
  return out
}

/** Everything useful for debugging, nothing personal: no profile, no companies, no email content. */
export async function diagnostics(): Promise<object> {
  const s = await getSettings()
  const [applied, unlogged, unmatched, answers, resumes, queue] = await Promise.all([
    db.applied.count(),
    db.unlogged.count(),
    db.unmatched.count(),
    db.answers.count(),
    db.resumes.count(),
    db.queue.orderBy('createdAt').toArray(),
  ])
  return {
    zipply: chrome.runtime.getManifest().version,
    chrome: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? '',
    at: new Date().toISOString(),
    settings: {
      googleConnected: Boolean(s.googleEmail),
      hasSheet: Boolean(s.sheetId),
      sheetReady: s.sheetReady,
      gmailEnabled: s.gmailEnabled,
      lastGmailSync: s.lastGmailSync ? new Date(s.lastGmailSync).toISOString() : null,
      models: s.models,
      dailyLimits: s.dailyLimits,
      autoDraft: s.autoDraft,
      fillThreshold: s.fillThreshold,
      listingScores: s.listingScores,
      encrypted: s.encrypted,
    },
    health: await healthChecks(),
    counts: { applied, unlogged, unmatched, answers, resumes, queued: queue.length },
    queue: queue.map((q) => ({ op: q.op, attempts: q.attempts, lastError: scrub(q.lastError), ageHours: Math.round((Date.now() - q.createdAt) / 3_600_000) })),
    errors: (await recentErrors()).map((e) => ({ at: new Date(e.at).toISOString(), where: e.where, message: e.message })),
  }
}

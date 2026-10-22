// One router makes every AI call and keeps a daily count per model. Writing goes
// Flash → Flash-Lite → Nano → you. It never retries into a paid tier (there is none).
import { getGeminiKey, getSettings } from '@/lib/repo'
import { nanoPrompt, nanoStatus, type NanoStatus } from '@/lib/nano'
import { bumpUsage as bump, usageCount } from '@/lib/usage'
import { logError } from '@/lib/errlog'
import { geminiGenerate, QuotaError } from './gemini'

export type Tier = 'flash' | 'flashLite' | 'nano'

/**
 * Which models a job may use, cheapest that does it well first.
 * - write: answers, cover letters, tailoring tips (quality matters)
 * - map: field labels to profile keys (no personal data)
 * - check: grounding pass on a draft
 * - private: anything with resume text or email content (on-device only)
 */
export const CHAINS: Record<'write' | 'map' | 'check' | 'private', Tier[]> = {
  write: ['flash', 'flashLite', 'nano'],
  map: ['flashLite', 'nano'],
  check: ['flashLite', 'nano'],
  private: ['nano'],
}

export type Job = keyof typeof CHAINS

let offscreenReady: Promise<void> | null = null

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument?.()) return
  offscreenReady ??= chrome.offscreen
    .createDocument({
      url: 'src/offscreen/index.html',
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'Parse recruiting email HTML into text and run on-device Gemini Nano.',
    })
    .catch((e) => {
      if (!/single offscreen/i.test(String(e))) throw e
    })
    .finally(() => {
      offscreenReady = null
    })
  await offscreenReady
}

export async function offscreen<T>(msg: object): Promise<T> {
  await ensureOffscreen()
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg }) as Promise<T>
}

/** Nano here if the worker has the Prompt API, otherwise in the offscreen document. */
async function runNano(system: string, prompt: string, schema?: object): Promise<string | null> {
  if ('LanguageModel' in globalThis) return nanoPrompt(system, prompt, schema)
  const r = await offscreen<{ text?: string | null; error?: string }>({ type: 'nano', system, prompt, schema })
  return r?.text ?? null
}

export async function nanoAvailability(): Promise<NanoStatus> {
  if ('LanguageModel' in globalThis) return nanoStatus()
  try {
    return (await offscreen<{ status: NanoStatus }>({ type: 'nano-status' })).status
  } catch {
    return 'unsupported'
  }
}

export interface AiResult {
  text: string
  model: string
}

/**
 * Run a job down its chain. Returns null when every model is unavailable or
 * spent. `accept` rejects an unusable answer so the next model gets a try.
 */
export async function runAi(job: Job, system: string, prompt: string, schema?: object, accept: (text: string) => boolean = () => true): Promise<AiResult | null> {
  const s = await getSettings()
  const apiKey = CHAINS[job].some((t) => t !== 'nano') ? await getGeminiKey().catch(() => '') : ''
  for (const tier of CHAINS[job]) {
    try {
      if (tier === 'nano') {
        const text = await runNano(system, prompt, schema)
        if (text && accept(text)) {
          await bump('gemini-nano')
          return { text, model: 'gemini-nano' }
        }
        continue
      }
      if (!apiKey) continue
      const model = s.models[tier]
      if ((await usageCount(model)) >= s.dailyLimits[tier]) continue
      await bump(model)
      const text = await geminiGenerate({ apiKey, model, system, prompt, schema, temperature: job === 'write' ? 0.75 : 0.1 })
      if (!accept(text)) continue
      return { text, model }
    } catch (e) {
      if (e instanceof QuotaError) {
        // Spent for today: mark it so we stop trying until tomorrow.
        await bump(s.models[tier as 'flash' | 'flashLite'], s.dailyLimits[tier as 'flash' | 'flashLite'])
        continue
      }
      console.warn(`[zipply] ${tier} failed`, e)
      void logError(`ai ${tier}`, e)
    }
  }
  return null
}

export function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as T
  } catch {
    return null
  }
}

export async function runAiJson<T>(job: Job, system: string, prompt: string, schema: object): Promise<{ data: T; model: string } | null> {
  const r = await runAi(job, system, prompt, schema, (t) => parseJson(t) !== null)
  return r ? { data: parseJson<T>(r.text)!, model: r.model } : null
}

// Checking Nano spins up a background page, so the answer is kept for 10 minutes.
let nanoChecked: { at: number; ok: boolean } | null = null

export async function aiReady(): Promise<boolean> {
  const key = await getGeminiKey().catch(() => '')
  if (key) return true
  if (nanoChecked && Date.now() - nanoChecked.at < 600_000) return nanoChecked.ok
  const ok = (await nanoAvailability()) === 'available'
  nanoChecked = { at: Date.now(), ok }
  return ok
}

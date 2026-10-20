// Regression tests for the bugs fixed in the audit.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installChrome, resetStores, stores } from './chromeMock'

installChrome()

vi.mock('@/background/ai/gemini', () => {
  class QuotaError extends Error {}
  return { QuotaError, geminiGenerate: vi.fn() }
})

const { SENSITIVE_Q } = await import('@/content/fill')
const { markerConfirmation, noFormLeft } = await import('@/content/adapters/types')
const { pickAdapter } = await import('@/content/adapters')
const { collectFields } = await import('@/content/dom/collect')
const { updateSettings, getSettings, saveProfile, getProfile } = await import('@/lib/repo')
const { getKey } = await import('@/lib/keys')
const { db } = await import('@/lib/db')
const { runAiJson } = await import('@/background/ai/router')
const { geminiGenerate } = await import('@/background/ai/gemini')
const { emptyProfile } = await import('@/shared/defaults')

const html = (s: string) => {
  document.body.innerHTML = s
  return document
}

beforeEach(async () => {
  resetStores()
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('sensitive questions use whole words', () => {
  it('drafts ordinary questions that contain "age" or "pay" inside a word', () => {
    for (const q of ['Describe a project you managed', 'Which languages do you speak?', 'How do you engage stakeholders?', 'Link a page you built', 'Tell us about a payment system you designed'])
      expect(SENSITIVE_Q.test(q), q).toBe(false)
  })
  it('still skips sensitive ones', () => {
    for (const q of ['What are your salary expectations?', 'Will you require visa sponsorship?', 'What is your age?', 'Expected pay?', 'Are you authorized to work in the US?'])
      expect(SENSITIVE_Q.test(q), q).toBe(true)
  })
})

describe('confirmation markers need the form to be gone', () => {
  const form = '<form><input name=a><input name=b><input type=email name=c><div class="_emailConfirmation_x">Confirm your email</div></form>'
  it('ignores a "confirmation" class on the form page itself', () => {
    const doc = html(form)
    expect(markerConfirmation(doc, '[class*="confirmation" i]')).toBe(false)
    expect(pickAdapter(new URL('https://jobs.ashbyhq.com/acme/1/application'), doc).isConfirmation(doc, new URL('https://jobs.ashbyhq.com/acme/1/application'))).toBe(false)
  })
  it('accepts it once the form is replaced', () => {
    const doc = html('<div class="_success_1">Thanks for applying!</div>')
    expect(noFormLeft(doc)).toBe(true)
    expect(pickAdapter(new URL('https://jobs.ashbyhq.com/acme/1/application'), doc).isConfirmation(doc, new URL('https://jobs.ashbyhq.com/acme/1/application'))).toBe(true)
  })
})

describe('required fields', () => {
  it('does not mark every field required because a form wrapper says "required"', () => {
    html('<form class="required-fields-note"><div><label for=a>Nickname</label><input id=a></div><div class="field required"><label for=b>Email</label><input id=b></div></form>')
    const f = collectFields(document)
    expect(f.find((c) => c.desc.label === 'Nickname')!.desc.required).toBe(false)
    expect(f.find((c) => c.desc.label === 'Email')!.desc.required).toBe(true)
  })
})

describe('settings writes do not undo each other', () => {
  it('keeps both of two concurrent changes', async () => {
    await Promise.all([updateSettings({ sheetId: 'abc', sheetUrl: 'u' }), updateSettings({ autoDraft: false }), updateSettings({ fillThreshold: 0.8 })])
    const s = await getSettings()
    expect(s).toMatchObject({ sheetId: 'abc', autoDraft: false, fillThreshold: 0.8 })
  })
})

describe('first-run encryption key', () => {
  it('creates exactly one key when many callers race', async () => {
    const keys = await Promise.all(Array.from({ length: 6 }, () => getKey()))
    const raw = await Promise.all(keys.map(async (k) => Buffer.from(await crypto.subtle.exportKey('raw', k)).toString('hex')))
    expect(new Set(raw).size).toBe(1)
    const p = emptyProfile()
    p.basics.firstName = 'Ada'
    await saveProfile(p)
    stores.session = {}
    expect((await getProfile()).basics.firstName).toBe('Ada')
  })
})

describe('AI router', () => {
  it('tries the next model when one returns unreadable JSON', async () => {
    await (await import('@/lib/repo')).setGeminiKey('k')
    vi.mocked(geminiGenerate).mockReset()
    vi.mocked(geminiGenerate).mockResolvedValueOnce('not json at all').mockResolvedValueOnce('{"ok": true}')
    ;(globalThis as { LanguageModel?: unknown }).LanguageModel = undefined
    const r = await runAiJson<{ ok: boolean }>('write', 's', 'p', {})
    expect(r?.data).toEqual({ ok: true })
    expect(vi.mocked(geminiGenerate)).toHaveBeenCalledTimes(2)
  })
})

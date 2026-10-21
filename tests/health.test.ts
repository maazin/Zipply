import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installChrome, resetStores } from './chromeMock'

installChrome({ runtime: { sendMessage: async () => ({}), getManifest: () => ({ version: '0.1.0' }) } })

const state = { signedIn: true, sheetStatus: 200 }
vi.mock('@/background/google', () => {
  class NotConnectedError extends Error {}
  class HttpError extends Error {
    constructor(public status: number, m: string) { super(m) }
  }
  return {
    SCOPES: { drive: 'd', gmail: 'g' },
    NotConnectedError,
    HttpError,
    getToken: async () => {
      if (!state.signedIn) throw new NotConnectedError('no')
      return 't'
    },
    gfetch: async () => {
      if (state.sheetStatus !== 200) throw new HttpError(state.sheetStatus, `Google API ${state.sheetStatus}`)
      return {}
    },
  }
})
vi.mock('@/background/ai/router', () => ({ nanoAvailability: async () => 'unavailable' }))

const { healthChecks, diagnostics } = await import('@/background/health')
const { updateSettings, setGeminiKey } = await import('@/lib/repo')
const { db } = await import('@/lib/db')
const { logError, scrub, recentErrors } = await import('@/lib/errlog')

const byName = (checks: { name: string; ok: boolean | null; detail: string }[], n: string) => checks.find((c) => c.name === n)!

beforeEach(async () => {
  resetStores()
  await Promise.all(db.tables.map((t) => t.clear()))
  state.signedIn = true
  state.sheetStatus = 200
  globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch
})

describe('health checks', () => {
  it('says what to do when Google is not connected', async () => {
    state.signedIn = false
    const c = await healthChecks()
    expect(byName(c, 'Google')).toMatchObject({ ok: false, detail: expect.stringMatching(/Sign in with Google/) })
    expect(byName(c, 'Sheet').ok).toBe(false)
  })

  it('reports a deleted sheet and an unfinished setup', async () => {
    await updateSettings({ sheetId: 's1', sheetReady: false })
    expect(byName(await healthChecks(), 'Sheet')).toMatchObject({ ok: false, detail: expect.stringMatching(/setup unfinished/) })
    state.sheetStatus = 404
    expect(byName(await healthChecks(), 'Sheet').detail).toMatch(/Deleted/)
  })

  it('checks the Gemini key without spending quota and explains a bad key', async () => {
    await setGeminiKey('AIzaBAD')
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 400 })) as typeof fetch
    expect(byName(await healthChecks(), 'Gemini key')).toMatchObject({ ok: false, detail: expect.stringMatching(/rejected the key/) })
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0][0])).toMatch(/\/v1beta\/models\/gemini-flash-latest$/)
  })

  it('shows a waiting queue with its last error', async () => {
    await db.queue.add({ op: 'append', payload: { company: 'Globex', title: 'Analyst' }, attempts: 2, lastError: 'Google API 500', createdAt: 1 })
    expect(byName(await healthChecks(), 'Queue')).toMatchObject({ ok: false, detail: expect.stringMatching(/1 waiting.*500/) })
  })
})

describe('diagnostics and the error log', () => {
  it('scrubs emails, phone numbers, keys and link queries', () => {
    expect(scrub('ada@example.com called (813) 555-0100 with AIzaSyA1234567890abcdefghij at https://x.com/a?token=s')).toBe('[email] called [phone] with [key] at https://x.com/a')
  })

  it('keeps only the last 50 errors', async () => {
    for (let i = 0; i < 55; i++) await logError('test', new Error(`e${i}`))
    const list = await recentErrors()
    expect(list).toHaveLength(50)
    expect(list[49].message).toBe('Error: e54')
  })

  it('contains no companies, titles, emails or keys', async () => {
    await setGeminiKey('AIzaSyA1234567890abcdefghij')
    await updateSettings({ googleEmail: 'ada@example.com', sheetId: 's1' })
    await db.queue.add({ op: 'append', payload: { company: 'Globex', title: 'Secret Role' }, attempts: 1, lastError: 'failed for ada@example.com', createdAt: 1 })
    await logError('x', new Error('boom ada@example.com'))
    const text = JSON.stringify(await diagnostics())
    expect(text).not.toMatch(/Globex|Secret Role|@example\.com|AIzaSy/)
    expect(text).toContain('"queued":1')
  })
})

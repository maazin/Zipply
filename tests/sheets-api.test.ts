// ensureSheet against a fake Sheets API: one sheet, no matter what fails.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store: Record<string, unknown> = {}
const syncStore: Record<string, unknown> = {}
const areaOf = (s: Record<string, unknown>) => ({
  get: async (k: string) => (k in s ? { [k]: structuredClone(s[k]) } : {}),
  set: async (o: Record<string, unknown>) => void Object.assign(s, structuredClone(o)),
  remove: async (k: string) => void delete s[k],
})
const area = areaOf(store)
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { local: area, session: area, sync: areaOf(syncStore), onChanged: { addListener() {} } },
  identity: { getAuthToken: async () => ({ token: 't' }), removeCachedAuthToken: async () => {} },
}

let sheets: string[] = []
let failValuesOnce = false
let getStatus = 200
let createFails: 'network' | 500 | null = null

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  await new Promise((r) => setTimeout(r, 5))
  if (method === 'POST' && url === 'https://sheets.googleapis.com/v4/spreadsheets') {
    if (createFails === 500) return json({ error: { message: 'backend error' } }, 500)
    const id = `sheet${sheets.length + 1}`
    sheets.push(id)
    // The sheet exists on Google's side, but the reply never arrives.
    if (createFails === 'network') throw new TypeError('Failed to fetch')
    return json({ spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}`, sheets: [] })
  }
  if (url.includes('/values:batchUpdate')) {
    if (failValuesOnce) {
      failValuesOnce = false
      return json({ error: { message: 'Requested writing within range [Dashboard!A11:B16], but tried writing to row [17]' } }, 400)
    }
    return json({})
  }
  if (url.endsWith(':batchUpdate')) return json({})
  if (url.includes('fields=sheets.properties'))
    return json({ sheets: [{ properties: { sheetId: 0, title: 'Applications' } }, { properties: { sheetId: 1, title: 'Dashboard' } }] })
  if (url.includes('fields=spreadsheetId')) return getStatus === 200 ? json({ spreadsheetId: 'x' }) : json({ error: { message: 'nope' } }, getStatus)
  if (url.includes('/values/') && method === 'GET') return json({ values: [] })
  return json({ error: { message: `unexpected ${method} ${url}` } }, 500)
}) as typeof fetch

const { ensureSheet, NoSheetError, SheetMissingError, CREATE_COOLDOWN, readApplied, sheetAppIds, writeStatus } = await import('@/background/sheets')
const settings = () => store.settings as { sheetId: string; sheetReady: boolean; sheetMissing: boolean }

beforeEach(() => {
  for (const s of [store, syncStore]) for (const k of Object.keys(s)) delete s[k]
  sheets = []
  failValuesOnce = false
  getStatus = 200
  createFails = null
  vi.useRealTimers()
})

describe('ensureSheet', () => {
  it('creates one sheet when an application is logged, and reuses it', async () => {
    expect(await ensureSheet({ create: true })).toBe('sheet1')
    expect(await ensureSheet({ create: true })).toBe('sheet1')
    expect(await ensureSheet()).toBe('sheet1')
    expect(sheets).toHaveLength(1)
  })

  it('never creates a sheet for reads, refreshes or Gmail status updates', async () => {
    await expect(ensureSheet()).rejects.toBeInstanceOf(NoSheetError)
    await expect(readApplied()).rejects.toBeInstanceOf(NoSheetError)
    await expect(sheetAppIds()).rejects.toBeInstanceOf(NoSheetError)
    await expect(writeStatus({ appId: 'a', status: 'Interview', firstReply: '', lastStatusChange: '' })).rejects.toBeInstanceOf(NoSheetError)
    expect(sheets).toHaveLength(0)
  })

  it('finishes setup on the same sheet after a failure instead of making another', async () => {
    failValuesOnce = true
    await expect(ensureSheet({ create: true })).rejects.toThrow(/Dashboard/)
    expect(await ensureSheet({ create: true })).toBe('sheet1')
    expect(await ensureSheet({ create: true })).toBe('sheet1')
    expect(sheets).toHaveLength(1)
    expect(settings().sheetReady).toBe(true)
  })

  it('shares one attempt between concurrent callers', async () => {
    const ids = await Promise.all([ensureSheet({ create: true }), ensureSheet({ create: true }), ensureSheet({ create: true })])
    expect(new Set(ids).size).toBe(1)
    expect(sheets).toHaveLength(1)
  })

  it('does not make a new sheet on a permissions error', async () => {
    await ensureSheet({ create: true })
    getStatus = 403
    await expect(ensureSheet({ create: true })).rejects.toThrow()
    expect(sheets).toHaveLength(1)
  })

  it('asks you instead of replacing a sheet that seems to be gone', async () => {
    await ensureSheet({ create: true })
    getStatus = 404
    for (let i = 0; i < 5; i++) await expect(ensureSheet({ create: true })).rejects.toBeInstanceOf(SheetMissingError)
    expect(sheets).toHaveLength(1)
    expect(settings().sheetMissing).toBe(true)
    // Restored from the trash: the warning clears, still one sheet.
    getStatus = 200
    expect(await ensureSheet()).toBe('sheet1')
    expect(settings().sheetMissing).toBe(false)
    // Really gone and you press Create a new sheet: exactly one more.
    getStatus = 404
    expect(await ensureSheet({ force: true })).toBe('sheet2')
    expect(sheets).toHaveLength(2)
  })

  it('Create a new sheet never replaces one that still exists', async () => {
    await ensureSheet({ create: true })
    expect(await ensureSheet({ force: true })).toBe('sheet1')
    expect(sheets).toHaveLength(1)
  })

  it('finds the sheet again when settings are wiped', async () => {
    await ensureSheet({ create: true })
    delete store.settings
    expect(await ensureSheet({ create: true })).toBe('sheet1')
    expect(settings().sheetId).toBe('sheet1')
    expect(sheets).toHaveLength(1)
  })

  it('finds the sheet from Chrome sync after a reinstall wipes local storage', async () => {
    await ensureSheet({ create: true })
    for (const k of Object.keys(store)) delete store[k]
    expect(await ensureSheet({ create: true })).toBe('sheet1')
    expect(sheets).toHaveLength(1)
  })

  it('makes at most one sheet a day when the reply to a create is lost', async () => {
    createFails = 'network'
    await expect(ensureSheet({ create: true })).rejects.toThrow()
    createFails = null
    for (let i = 0; i < 5; i++) await expect(ensureSheet({ create: true })).rejects.toThrow(/already created in the last day/)
    expect(sheets).toHaveLength(1)
    // A day later, it may try again.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + CREATE_COOLDOWN + 1000)
    expect(await ensureSheet({ create: true })).toBe('sheet2')
  })

  it('retries right away when Google refused the create (nothing was made)', async () => {
    createFails = 500
    await expect(ensureSheet({ create: true })).rejects.toThrow(/500/)
    createFails = null
    expect(await ensureSheet({ create: true })).toBe('sheet1')
    expect(sheets).toHaveLength(1)
  })

  it('makes one sheet over many background runs with no sheet yet', async () => {
    // Every 15 minutes for a day: queue flushes, refreshes, Gmail sync.
    for (let i = 0; i < 96; i++) {
      await sheetAppIds().catch(() => undefined)
      await readApplied().catch(() => undefined)
    }
    expect(sheets).toHaveLength(0)
    await ensureSheet({ create: true })
    for (let i = 0; i < 96; i++) await ensureSheet({ create: true })
    expect(sheets).toHaveLength(1)
  })
})

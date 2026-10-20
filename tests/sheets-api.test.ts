// ensureSheet against a fake Sheets API: one sheet, no matter what fails.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store: Record<string, unknown> = {}
const area = {
  get: async (k: string) => (k in store ? { [k]: store[k] } : {}),
  set: async (o: Record<string, unknown>) => void Object.assign(store, o),
  remove: async (k: string) => void delete store[k],
}
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { local: area, session: area, onChanged: { addListener() {} } },
  identity: { getAuthToken: async () => ({ token: 't' }), removeCachedAuthToken: async () => {} },
}

let sheets: string[] = []
let failValuesOnce = false
let getStatus = 200

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  await new Promise((r) => setTimeout(r, 5))
  if (method === 'POST' && url === 'https://sheets.googleapis.com/v4/spreadsheets') {
    const id = `sheet${sheets.length + 1}`
    sheets.push(id)
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
  return json({ error: { message: `unexpected ${method} ${url}` } }, 500)
}) as typeof fetch

const { ensureSheet } = await import('@/background/sheets')

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k]
  sheets = []
  failValuesOnce = false
  getStatus = 200
})

describe('ensureSheet', () => {
  it('creates one sheet and reuses it', async () => {
    expect(await ensureSheet()).toBe('sheet1')
    expect(await ensureSheet()).toBe('sheet1')
    expect(sheets).toHaveLength(1)
  })

  it('finishes setup on the same sheet after a failure instead of making another', async () => {
    failValuesOnce = true
    await expect(ensureSheet()).rejects.toThrow(/Dashboard/)
    expect(await ensureSheet()).toBe('sheet1')
    expect(await ensureSheet()).toBe('sheet1')
    expect(sheets).toHaveLength(1)
    expect((store.settings as { sheetReady: boolean }).sheetReady).toBe(true)
  })

  it('shares one attempt between concurrent callers', async () => {
    const ids = await Promise.all([ensureSheet(), ensureSheet(), ensureSheet()])
    expect(new Set(ids).size).toBe(1)
    expect(sheets).toHaveLength(1)
  })

  it('does not make a new sheet on a permissions error', async () => {
    await ensureSheet()
    getStatus = 403
    await expect(ensureSheet()).rejects.toThrow()
    expect(sheets).toHaveLength(1)
  })

  it('makes a new sheet only when the old one is gone', async () => {
    await ensureSheet()
    getStatus = 404
    expect(await ensureSheet()).toBe('sheet2')
    expect(sheets).toHaveLength(2)
  })
})

import type { AppliedEntry, AppStatus, JobRecord } from '@/shared/types'
import { APPS, COLUMNS, DASH, LAST_COL, dashboardData, dashboardRequests, entryFromRecord, parseRows, toRow, COL } from '@/core/sheets/layout'
import { db } from '@/lib/db'
import { getSettings, updateSettings } from '@/lib/repo'
import { gfetch, HttpError, SCOPES } from './google'

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const S = [SCOPES.drive]

/** Write the header row and the Dashboard tab. Safe to run again on the same sheet. */
async function setupSheet(id: string): Promise<void> {
  const meta = await gfetch<{ sheets: { properties: { sheetId: number; title: string } }[] }>(`${BASE}/${id}?fields=sheets.properties(sheetId,title)`, S)
  const appsId = meta.sheets.find((s) => s.properties.title === APPS)?.properties.sheetId
  const dashId = meta.sheets.find((s) => s.properties.title === DASH)?.properties.sheetId
  if (appsId == null || dashId == null) throw new Error(`The sheet is missing its ${APPS} or ${DASH} tab`)
  await gfetch(`${BASE}/${id}/values:batchUpdate`, S, {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: [{ range: `${APPS}!A1:${LAST_COL}1`, values: [COLUMNS as unknown as string[]] }, ...dashboardData()],
    }),
  })
  await gfetch(`${BASE}/${id}:batchUpdate`, S, {
    method: 'POST',
    body: JSON.stringify({ requests: dashboardRequests(appsId, dashId) }),
  })
  await updateSettings({ sheetReady: true })
}

/**
 * Create the tracker sheet. Its ID is saved the moment it exists, so if
 * setting up the tabs fails, the next attempt finishes this sheet instead of
 * making another one.
 */
async function createSheet(interactive: boolean): Promise<string> {
  const created = await gfetch<{ spreadsheetId: string; spreadsheetUrl: string }>(
    BASE,
    S,
    {
      method: 'POST',
      body: JSON.stringify({
        properties: { title: 'Zipply applications' },
        sheets: [
          { properties: { title: APPS, gridProperties: { frozenRowCount: 1 } } },
          { properties: { title: DASH } },
        ],
      }),
    },
    interactive,
  )
  await updateSettings({ sheetId: created.spreadsheetId, sheetUrl: created.spreadsheetUrl, sheetReady: false })
  await setupSheet(created.spreadsheetId)
  return created.spreadsheetId
}

let pending: Promise<string> | null = null

/**
 * The sheet ID. Creates the sheet only when there is none, or when Google says
 * the saved one no longer exists (404). Concurrent callers share one attempt.
 */
export function ensureSheet(interactive = false): Promise<string> {
  pending ??= (async () => {
    const s = await getSettings()
    if (!s.sheetId) return createSheet(interactive)
    try {
      await gfetch(`${BASE}/${s.sheetId}?fields=spreadsheetId`, S, {}, interactive)
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        await updateSettings({ sheetId: '', sheetUrl: '', sheetReady: false })
        return createSheet(interactive)
      }
      throw e
    }
    if (!s.sheetReady) await setupSheet(s.sheetId)
    return s.sheetId
  })().finally(() => {
    pending = null
  })
  return pending
}

export async function readApplied(): Promise<AppliedEntry[]> {
  const id = await ensureSheet()
  const res = await gfetch<{ values?: string[][] }>(
    `${BASE}/${id}/values/${encodeURIComponent(`${APPS}!A2:${LAST_COL}`)}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    S,
  )
  return parseRows(res.values ?? [])
}

/** Reload the local already-applied cache from the sheet. */
export async function refreshApplied(): Promise<AppliedEntry[]> {
  const fromSheet = await readApplied()
  // Keep submissions still waiting in the retry queue.
  const pending = (await db.queue.toArray()).filter((q) => q.op === 'append').map((q) => entryFromRecord(q.payload as JobRecord))
  const ids = new Set(fromSheet.map((r) => r.appId))
  const rows = [...fromSheet, ...pending.filter((p) => !ids.has(p.appId))]
  await db.transaction('rw', db.applied, async () => {
    await db.applied.clear()
    await db.applied.bulkPut(rows)
  })
  return rows
}

export async function appendRecord(r: JobRecord): Promise<number | undefined> {
  const id = await ensureSheet()
  const res = await gfetch<{ updates?: { updatedRange?: string } }>(
    `${BASE}/${id}/values/${encodeURIComponent(`${APPS}!A1:${LAST_COL}1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    S,
    { method: 'POST', body: JSON.stringify({ values: [toRow(r)] }) },
  )
  const m = res.updates?.updatedRange?.match(/![A-Z]+(\d+)/)
  return m ? Number(m[1]) : undefined
}

/** Application IDs already in the sheet (column A). */
export async function sheetAppIds(): Promise<Set<string>> {
  const id = await ensureSheet()
  const col = await gfetch<{ values?: string[][] }>(`${BASE}/${id}/values/${encodeURIComponent(`${APPS}!A2:A`)}`, S)
  return new Set((col.values ?? []).map((r) => r[0]).filter(Boolean))
}

export class MissingRowError extends Error {
  constructor(appId: string) {
    super(`Application ${appId} is no longer in the sheet`)
    this.name = 'MissingRowError'
  }
}

export interface StatusUpdate {
  appId: string
  status: AppStatus
  firstReply: string
  lastStatusChange: string
}

/** Write Status, First reply and Last status change for one application. */
export async function writeStatus(u: StatusUpdate): Promise<void> {
  const id = await ensureSheet()
  // Find the row by Application ID (rows can be sorted or edited by hand).
  const col = await gfetch<{ values?: string[][] }>(`${BASE}/${id}/values/${encodeURIComponent(`${APPS}!A:A`)}`, S)
  const idx = (col.values ?? []).findIndex((r) => r[0] === u.appId)
  if (idx < 1) throw new MissingRowError(u.appId)
  const row = idx + 1
  await gfetch(
    `${BASE}/${id}/values/${encodeURIComponent(`${APPS}!${COL['Status']}${row}:${COL['Last status change']}${row}`)}?valueInputOption=USER_ENTERED`,
    S,
    { method: 'PUT', body: JSON.stringify({ values: [[u.status, u.firstReply, u.lastStatusChange]] }) },
  )
}

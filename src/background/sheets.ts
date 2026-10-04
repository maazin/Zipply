import type { AppliedEntry, AppStatus, JobRecord } from '@/shared/types'
import { APPS, COLUMNS, DASH, LAST_COL, dashboardData, dashboardRequests, entryFromRecord, parseRows, toRow, COL } from '@/core/sheets/layout'
import { db } from '@/lib/db'
import { getSettings, updateSettings } from '@/lib/repo'
import { gfetch, HttpError, SCOPES } from './google'

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const S = [SCOPES.drive]

interface SpreadsheetResp {
  spreadsheetId: string
  spreadsheetUrl: string
  sheets: { properties: { sheetId: number; title: string } }[]
}

/** Create the tracker sheet with its Applications and Dashboard tabs. */
export async function createSheet(interactive = true): Promise<{ id: string; url: string }> {
  const created = await gfetch<SpreadsheetResp>(
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
  const id = created.spreadsheetId
  const appsId = created.sheets.find((s) => s.properties.title === APPS)!.properties.sheetId
  const dashId = created.sheets.find((s) => s.properties.title === DASH)!.properties.sheetId

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
  await updateSettings({ sheetId: id, sheetUrl: created.spreadsheetUrl })
  return { id, url: created.spreadsheetUrl }
}

/** The sheet ID, creating the sheet if needed (or if it was deleted). */
export async function ensureSheet(interactive = false): Promise<string> {
  const s = await getSettings()
  if (s.sheetId) {
    try {
      await gfetch(`${BASE}/${s.sheetId}?fields=spreadsheetId`, S, {}, interactive)
      return s.sheetId
    } catch (e) {
      if (!(e instanceof HttpError && (e.status === 404 || e.status === 403))) throw e
    }
  }
  return (await createSheet(interactive)).id
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
  if (idx < 1) throw new Error(`Application ${u.appId} is no longer in the sheet`)
  const row = idx + 1
  await gfetch(
    `${BASE}/${id}/values/${encodeURIComponent(`${APPS}!${COL['Status']}${row}:${COL['Last status change']}${row}`)}?valueInputOption=USER_ENTERED`,
    S,
    { method: 'PUT', body: JSON.stringify({ values: [[u.status, u.firstReply, u.lastStatusChange]] }) },
  )
}

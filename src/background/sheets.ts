import type { AppliedEntry, AppStatus, JobRecord } from '@/shared/types'
import { APPS, COLUMNS, DASH, LAST_COL, dashboardData, dashboardRequests, entryFromRecord, parseRows, toRow, COL } from '@/core/sheets/layout'
import { db } from '@/lib/db'
import { getSettings, updateSettings } from '@/lib/repo'
import { local, synced } from '@/lib/store'
import { withLock } from '@/lib/lock'
import { gfetch, HttpError, NotConnectedError, SCOPES } from './google'

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

// ---------- One sheet, ever ----------
//
// The sheet's ID is kept in its own record (not inside settings, so no
// settings write can lose it), in both local and Chrome sync storage, so it
// survives a reinstall. Creating a sheet is a last resort:
// - only for a logged application or Sign in with Google, never for reads,
//   Gmail sync or refreshes;
// - never because the saved sheet seems to be gone: you're asked instead;
// - at most once a day, unless you press "Create a new sheet" yourself.

const RECORD = 'sheetRecord'
/** No automatic second sheet within this long of the last attempt. */
export const CREATE_COOLDOWN = 24 * 60 * 60_000

interface SheetRecord {
  id: string
  url: string
  /** When a sheet was last created, or creation last attempted. */
  createdAt: number
}

async function readRecord(): Promise<SheetRecord | null> {
  const [l, s] = await Promise.all([local.get<SheetRecord>(RECORD).catch(() => undefined), synced.get<SheetRecord>(RECORD)])
  // Prefer one with an ID; then the newer.
  const all = [l, s].filter((r): r is SheetRecord => Boolean(r))
  return all.sort((a, b) => Number(Boolean(b.id)) - Number(Boolean(a.id)) || b.createdAt - a.createdAt)[0] ?? null
}

async function writeRecord(r: SheetRecord): Promise<void> {
  await Promise.all([local.set(RECORD, r), synced.set(RECORD, r)])
}

export class NoSheetError extends Error {
  constructor(msg = 'No sheet yet. It is created when you log your first application.') {
    super(msg)
    this.name = 'NoSheetError'
  }
}

export class SheetMissingError extends Error {
  constructor() {
    super("Your Zipply sheet can't be found. Open Profile > Connections and choose Create a new sheet, or restore it from Drive's trash.")
    this.name = 'SheetMissingError'
  }
}

/** Create the tracker sheet. The ID is saved the moment it exists. */
async function createSheet(interactive: boolean): Promise<string> {
  // Mark the attempt first: if the reply is lost, we still don't try again today.
  await writeRecord({ id: '', url: '', createdAt: Date.now() })
  let created: { spreadsheetId: string; spreadsheetUrl: string }
  try {
    created = await gfetch(
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
  } catch (e) {
    // Google answered with an error or we never reached it: nothing was created.
    if (e instanceof HttpError || e instanceof NotConnectedError) await writeRecord({ id: '', url: '', createdAt: 0 })
    throw e
  }
  await writeRecord({ id: created.spreadsheetId, url: created.spreadsheetUrl, createdAt: Date.now() })
  await updateSettings({ sheetId: created.spreadsheetId, sheetUrl: created.spreadsheetUrl, sheetReady: false, sheetMissing: false })
  await setupSheet(created.spreadsheetId)
  return created.spreadsheetId
}

export interface EnsureOpts {
  /** May create the sheet if you have none (logging an application, signing in). */
  create?: boolean
  /** You pressed "Create a new sheet": skip the once-a-day limit and replace a missing one. */
  force?: boolean
  interactive?: boolean
}

let pending: Promise<string> | null = null

/**
 * The sheet ID. Concurrent callers share one attempt, and so do the extension's
 * pages (a cross-context lock), so two can never create a sheet each.
 */
export function ensureSheet(opts: EnsureOpts = {}): Promise<string> {
  pending ??= withLock('zipply-sheet', () => findOrCreate(opts)).finally(() => {
    pending = null
  })
  return pending
}

async function findOrCreate({ create = false, force = false, interactive = false }: EnsureOpts): Promise<string> {
  const s = await getSettings()
  const rec = await readRecord()
  let id = s.sheetId || rec?.id || ''
  let url = s.sheetUrl || rec?.url || ''

  if (force && id) {
    // Only replace a sheet that is really gone.
    const st = await sheetStatus(id, interactive)
    if (st === 200) return finish(id, s.sheetReady)
    id = ''
    url = ''
  }

  if (id) {
    // Keep both copies of the ID in step.
    if (!s.sheetId) await updateSettings({ sheetId: id, sheetUrl: url })
    if (!rec?.id) await writeRecord({ id, url, createdAt: rec?.createdAt ?? 0 })
    const st = await sheetStatus(id, interactive)
    if (st === 404) {
      await updateSettings({ sheetMissing: true })
      throw new SheetMissingError()
    }
    return finish(id, s.sheetId === id && s.sheetReady)
  }

  if (!create && !force) throw new NoSheetError()
  if (!force && rec && Date.now() - rec.createdAt < CREATE_COOLDOWN)
    throw new Error('A sheet was already created in the last day. To make another, choose Create a new sheet on the Profile page.')
  return createSheet(interactive)
}

/** 200 if the sheet is there, 404 if Google says it's gone. Other errors throw. */
async function sheetStatus(id: string, interactive: boolean): Promise<200 | 404> {
  try {
    await gfetch(`${BASE}/${id}?fields=spreadsheetId`, S, {}, interactive)
    return 200
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return 404
    throw e
  }
}

async function finish(id: string, ready: boolean): Promise<string> {
  if ((await getSettings()).sheetMissing) await updateSettings({ sheetMissing: false })
  if (!ready) await setupSheet(id)
  return id
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

/** Add one application. The only write that may create the sheet. */
export async function appendRecord(r: JobRecord): Promise<number | undefined> {
  const id = await ensureSheet({ create: true })
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

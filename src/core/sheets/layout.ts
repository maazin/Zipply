/*
 * Sheet layout: the Applications tab's columns and formatting. The Dashboard
 * tab is in ./dashboard.
 */
import type { AppliedEntry, AppStatus, JobRecord } from '@/shared/types'
import { normalizeCompany, toISODate } from '@/shared/text'
import { appliedKey } from '../score/applied'

export const APPS = 'Applications'

export const COLUMNS = [
  'Application ID',
  'Date applied',
  'Company',
  'Job title',
  'Location / remote',
  'Job ID',
  'ATS',
  'Posting URL',
  'Resume used',
  'Match score',
  'Verdict',
  'Red flags',
  'Status',
  'First reply',
  'Last status change',
  'Notes',
] as const

export const COL = Object.fromEntries(COLUMNS.map((c, i) => [c, String.fromCharCode(65 + i)])) as Record<(typeof COLUMNS)[number], string>
export const LAST_COL = COL['Notes']

/** Keep user-provided text from being read as a formula. */
function safe(s: string | number): string | number {
  if (typeof s === 'number') return s
  return /^[=+\-@]/.test(s) ? `'${s}` : s
}

export function toRow(r: JobRecord): (string | number)[] {
  return [
    r.appId,
    r.dateApplied,
    r.company,
    r.title,
    r.location,
    r.jobId,
    r.ats,
    r.url,
    r.resumeUsed,
    r.matchScore,
    r.verdict,
    r.redFlags,
    r.status,
    r.firstReply,
    r.lastStatusChange,
    r.notes,
  ].map(safe)
}

export function entryFromRecord(r: JobRecord, row?: number): AppliedEntry {
  return {
    key: appliedKey(r.company, r.jobId, r.url),
    appId: r.appId,
    company: r.company,
    companyNorm: normalizeCompany(r.company),
    title: r.title,
    jobId: r.jobId,
    url: r.url,
    dateApplied: r.dateApplied,
    status: r.status,
    firstReply: r.firstReply,
    lastStatusChange: r.lastStatusChange,
    row,
  }
}

export const STATUSES: AppStatus[] = ['Applied', 'Received', 'Assessment', 'Interview', 'Offer', 'Rejected']

/** Statuses typed by hand in other words ("rejected", "Declined", "Interviewing"). */
const STATUS_WORDS: [RegExp, AppStatus][] = [
  [/^(rejected|declined|not selected|no offer|turned down)$/i, 'Rejected'],
  [/^(interview(ing|ed)?|phone screen|onsite)$/i, 'Interview'],
  [/^(assessment|oa|online assessment|take[- ]home|coding challenge)$/i, 'Assessment'],
  [/^(offer(ed)?)$/i, 'Offer'],
  [/^(received|acknowledged|in review|under review|reviewed)$/i, 'Received'],
]

export function readStatus(s: string): AppStatus {
  const t = s.trim()
  return STATUSES.find((x) => x.toLowerCase() === t.toLowerCase()) ?? STATUS_WORDS.find(([re]) => re.test(t))?.[1] ?? 'Applied'
}

/** Parse the Applications tab (without its header) into the local lookup cache. */
export function parseRows(values: string[][], firstRow = 2): AppliedEntry[] {
  const out: AppliedEntry[] = []
  values.forEach((v, i) => {
    const [appId, dateApplied, company, title, , jobId, , url, , , , , status, firstReply, lastStatusChange] = v.map((x) => String(x ?? ''))
    if (!appId && !company) return
    out.push({
      key: appliedKey(company, jobId, url),
      appId,
      company,
      companyNorm: normalizeCompany(company),
      title,
      jobId,
      url,
      // Dates may come back as serial numbers if the cells lost their date format.
      dateApplied: toISODate(dateApplied),
      status: readStatus(status),
      firstReply: toISODate(firstReply),
      lastStatusChange: toISODate(lastStatusChange),
      row: firstRow + i,
    })
  })
  return out
}

/**
 * A whole column of the Applications tab. Not "B2:B": Sheets moves such a range
 * down whenever a row is inserted above it, and the dashboard then skipped every
 * application added that way. The header row is text, so formulas skip it.
 */
export const A = (col: keyof typeof COL) => `${APPS}!${COL[col]}:${COL[col]}`

/** A company answered: a decision or a next step, not an automatic "we received it". */
export const ANSWERED: AppStatus[] = ['Assessment', 'Interview', 'Offer', 'Rejected']

/** Status chips: background and text, the text dark enough to read on its chip. */
export const CHIPS: [AppStatus, string, string][] = [
  ['Offer', '#e3f4e3', '#006300'],
  ['Interview', '#ebe8fb', '#4a3aa7'],
  ['Assessment', '#fdf2d8', '#7a5200'],
  ['Received', '#e6effb', '#1c5cab'],
  ['Rejected', '#fbe4e4', '#a32929'],
]

export const hex = (h: string) => ({ red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255 })

/** Date format for Date applied, First reply and Last status change, down the whole column. */
export function appsDateFormats(appsSheetId: number): object[] {
  const col = (c0: number, c1: number) => ({
    repeatCell: {
      range: { sheetId: appsSheetId, startRowIndex: 1, startColumnIndex: c0, endColumnIndex: c1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  })
  return [col(1, 2), col(13, 15)]
}

/** The Applications tab: a frozen dark header, dates, a status dropdown and status colors. */
export function appsRequests(appsSheetId: number): object[] {
  const grid = (r0: number, r1: number, c0: number, c1: number) => ({ sheetId: appsSheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 })
  const status = COLUMNS.indexOf('Status')
  return [
    { updateSheetProperties: { properties: { sheetId: appsSheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    {
      repeatCell: {
        range: grid(0, 1, 0, COLUMNS.length),
        cell: { userEnteredFormat: { backgroundColor: hex('#1a1a19'), verticalAlignment: 'MIDDLE', textFormat: { bold: true, foregroundColor: hex('#ffffff') } } },
        fields: 'userEnteredFormat(backgroundColor,verticalAlignment,textFormat)',
      },
    },
    ...appsDateFormats(appsSheetId),
    {
      setDataValidation: {
        range: grid(1, 5000, status, status + 1),
        rule: {
          condition: { type: 'ONE_OF_LIST', values: STATUSES.map((s) => ({ userEnteredValue: s })) },
          strict: false,
          showCustomUi: true,
        },
      },
    },
    ...CHIPS.map(([s, bg, fg], index) => ({
      addConditionalFormatRule: {
        index,
        rule: {
          ranges: [grid(1, 5000, status, status + 1)],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: s }] },
            format: { backgroundColor: hex(bg), textFormat: { foregroundColor: hex(fg) } },
          },
        },
      },
    })),
  ]
}

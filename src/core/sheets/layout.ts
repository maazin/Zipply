/*
 * Sheet layout. The Dashboard tab's metrics are adapted from JobSync
 * (https://github.com/Gsync/jobsync) src/actions/dashboard (getJobsActivityForPeriod,
 * getActivityCalendarData), MIT. Modified: rebuilt as plain spreadsheet formulas
 * so the tab updates itself with no code. Staleness check from ai-job-search's
 * gmail-sync (MIT).
 */
import type { AppliedEntry, AppStatus, JobRecord } from '@/shared/types'
import { normalizeCompany } from '@/shared/text'
import { appliedKey } from '../score/applied'

export const APPS = 'Applications'
export const DASH = 'Dashboard'

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

const STATUSES: AppStatus[] = ['Applied', 'Received', 'Assessment', 'Interview', 'Offer', 'Rejected']

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
      dateApplied,
      status: (STATUSES.includes(status as AppStatus) ? status : 'Applied') as AppStatus,
      firstReply,
      lastStatusChange,
      row: firstRow + i,
    })
  })
  return out
}

const A = (col: keyof typeof COL) => `${APPS}!${COL[col]}2:${COL[col]}`

/**
 * Dashboard cells as [range, values] pairs, written with USER_ENTERED so the
 * formulas evaluate. Layout:
 *   A1 title, A3:B4 last 7 / 30 days (JobSync getJobsActivityForPeriod)
 *   A6:C9 response metrics, A11:C16 status funnel, A18:D21 results by verdict
 *   F1:G13 applications per week (12 weeks, charted)
 *   I1:U8 activity calendar, 7 days x 12 weeks (JobSync getActivityCalendarData)
 *   A24 going stale (30+ days, no reply)
 */
export function dashboardData(): { range: string; values: (string | number)[][] }[] {
  const date = A('Date applied')
  const status = A('Status')
  const verdict = A('Verdict')
  const first = A('First reply')
  const ids = A('Application ID')
  const total = `COUNTA(${ids})`

  const weekRows: (string | number)[][] = [['Week of', 'Applications']]
  for (let k = 11; k >= 0; k--) {
    const start = `TODAY()-WEEKDAY(TODAY(),3)-${7 * k}`
    weekRows.push([`=${start}`, `=COUNTIFS(${date},">="&(${start}),${date},"<"&(${start}+7))`])
  }

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const calHeader: (string | number)[] = ['']
  for (let k = 11; k >= 0; k--) calHeader.push(`=TODAY()-WEEKDAY(TODAY(),3)-${7 * k}`)
  const calRows: (string | number)[][] = [calHeader]
  days.forEach((d, di) => {
    const row: (string | number)[] = [d]
    for (let c = 0; c < 12; c++) {
      const colLetter = String.fromCharCode('J'.charCodeAt(0) + c)
      row.push(`=COUNTIF(${date},${colLetter}$1+${di})`)
    }
    calRows.push(row)
  })

  return [
    { range: `${DASH}!A1`, values: [['Zipply dashboard']] },
    {
      range: `${DASH}!A3:B4`,
      values: [
        ['Applications, last 7 days', `=COUNTIFS(${date},">="&(TODAY()-6))`],
        ['Applications, last 30 days', `=COUNTIFS(${date},">="&(TODAY()-29))`],
      ],
    },
    {
      range: `${DASH}!A6:B9`,
      values: [
        ['Total applications', `=${total}`],
        ['Response rate', `=IFERROR((${total}-COUNTIF(${status},"Applied"))/${total},0)`],
        ['Interview rate', `=IFERROR((COUNTIF(${status},"Interview")+COUNTIF(${status},"Offer"))/${total},0)`],
        ['Median days to first reply', `=IFERROR(MEDIAN(FILTER(${first}-${date},${first}<>"")),"")`],
      ],
    },
    {
      range: `${DASH}!A11:B16`,
      values: [['Status funnel', 'Count'], ...STATUSES.map((s) => [s, `=COUNTIF(${status},"${s}")`])],
    },
    {
      range: `${DASH}!A18:C21`,
      values: [
        ['Verdict', 'Applications', 'Response rate'],
        ...(['Apply', 'Maybe', 'Skip'] as const).map((v) => [
          v,
          `=COUNTIF(${verdict},"${v}")`,
          `=IFERROR(COUNTIFS(${verdict},"${v}",${status},"<>Applied")/COUNTIF(${verdict},"${v}"),"")`,
        ]),
      ],
    },
    { range: `${DASH}!F1:G13`, values: weekRows },
    { range: `${DASH}!I1:U8`, values: calRows },
    {
      range: `${DASH}!A23:A24`,
      values: [
        ['Going stale (no reply in 30+ days)'],
        [`=IFERROR(FILTER({${A('Company')},${A('Job title')},${date}},${status}="Applied",${first}="",${date}<>"",${date}<=TODAY()-30),"None")`],
      ],
    },
  ]
}

/** Formatting, the weekly chart and the calendar heat map (Sheets batchUpdate requests). */
export function dashboardRequests(appsSheetId: number, dashSheetId: number): object[] {
  const grid = (sheetId: number, r0: number, r1: number, c0: number, c1: number) => ({
    sheetId,
    startRowIndex: r0,
    endRowIndex: r1,
    startColumnIndex: c0,
    endColumnIndex: c1,
  })
  const fmt = (range: object, numberFormat: object) => ({
    repeatCell: { range, cell: { userEnteredFormat: { numberFormat } }, fields: 'userEnteredFormat.numberFormat' },
  })
  const bold = (range: object) => ({
    repeatCell: { range, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' },
  })
  return [
    bold(grid(appsSheetId, 0, 1, 0, COLUMNS.length)),
    fmt(grid(appsSheetId, 1, 5000, 1, 2), { type: 'DATE', pattern: 'yyyy-mm-dd' }),
    fmt(grid(appsSheetId, 1, 5000, 13, 15), { type: 'DATE', pattern: 'yyyy-mm-dd' }),
    {
      setDataValidation: {
        range: grid(appsSheetId, 1, 5000, 12, 13),
        rule: {
          condition: { type: 'ONE_OF_LIST', values: STATUSES.map((s) => ({ userEnteredValue: s })) },
          strict: false,
          showCustomUi: true,
        },
      },
    },
    bold(grid(dashSheetId, 0, 1, 0, 1)),
    bold(grid(dashSheetId, 10, 11, 0, 2)),
    bold(grid(dashSheetId, 17, 18, 0, 3)),
    bold(grid(dashSheetId, 22, 23, 0, 1)),
    fmt(grid(dashSheetId, 6, 8, 1, 2), { type: 'PERCENT', pattern: '0%' }),
    fmt(grid(dashSheetId, 18, 21, 2, 3), { type: 'PERCENT', pattern: '0%' }),
    fmt(grid(dashSheetId, 1, 13, 5, 6), { type: 'DATE', pattern: 'mmm d' }),
    fmt(grid(dashSheetId, 0, 1, 9, 21), { type: 'DATE', pattern: 'mmm d' }),
    fmt(grid(dashSheetId, 23, 200, 2, 3), { type: 'DATE', pattern: 'yyyy-mm-dd' }),
    {
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [grid(dashSheetId, 1, 8, 9, 21)],
          gradientRule: {
            minpoint: { color: { red: 0.96, green: 0.97, blue: 0.97 }, type: 'NUMBER', value: '0' },
            maxpoint: { color: { red: 0.13, green: 0.55, blue: 0.33 }, type: 'MAX' },
          },
        },
      },
    },
    {
      addChart: {
        chart: {
          spec: {
            title: 'Applications per week',
            basicChart: {
              chartType: 'LINE',
              legendPosition: 'NO_LEGEND',
              axis: [{ position: 'BOTTOM_AXIS' }, { position: 'LEFT_AXIS' }],
              domains: [{ domain: { sourceRange: { sources: [grid(dashSheetId, 1, 13, 5, 6)] } } }],
              series: [{ series: { sourceRange: { sources: [grid(dashSheetId, 1, 13, 6, 7)] } }, targetAxis: 'LEFT_AXIS' }],
            },
          },
          position: { overlayPosition: { anchorCell: { sheetId: dashSheetId, rowIndex: 9, columnIndex: 8 }, widthPixels: 560, heightPixels: 260 } },
        },
      },
    },
    { autoResizeDimensions: { dimensions: { sheetId: dashSheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 } } },
  ]
}

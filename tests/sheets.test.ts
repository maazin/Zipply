import { describe, expect, it } from 'vitest'
import { COLUMNS, appsRequests, parseRows, toRow } from '@/core/sheets/layout'
import { DASH_COLS, DASH_ROWS, colName, dashboardCells, dashboardData, dashboardRequests } from '@/core/sheets/dashboard'
import { recordFrom } from '@/background/log'
import { posting } from './helpers'

describe('sheet layout', () => {
  it('has the 16 PRD columns in order', () => {
    expect(COLUMNS).toHaveLength(16)
    expect(COLUMNS[0]).toBe('Application ID')
    expect(COLUMNS[12]).toBe('Status')
    expect(COLUMNS[15]).toBe('Notes')
  })
  it('round-trips a record and neutralizes formulas', () => {
    const rec = recordFrom(
      { posting: posting({ title: '=HYPERLINK("x")', workMode: 'hybrid' }), ats: 'Workday', resumeTag: 'Data', match: null, verdict: null, redFlags: { flags: ['No salary range'], tier: 'Proceed with caution' } },
      new Date('2026-10-04T10:00:00'),
    )
    const row = toRow(rec)
    expect(row).toHaveLength(16)
    expect(row[1]).toBe('2026-10-04')
    expect(row[3]).toBe(`'=HYPERLINK("x")`)
    expect(row[4]).toBe('Tampa, FL (Hybrid)')
    expect(row[11]).toBe('No salary range')
    const [entry] = parseRows([row.map(String)])
    expect(entry).toMatchObject({ appId: rec.appId, company: 'Globex, Inc.', companyNorm: 'globex', status: 'Applied', row: 2 })
  })
  it('builds the dashboard tab', () => {
    const data = dashboardData()
    const cells = JSON.stringify(data)
    // Whole columns: a range like B2:B moves down whenever a row is inserted under the header.
    expect(cells).toContain('COUNTIFS(Applications!B:B')
    expect(cells).not.toMatch(/Applications![A-Z]\d+:/)
    // "We received your application" isn't an answer.
    expect(data.flatMap((d) => d.values.flat()).join(' ')).toContain('{"Assessment","Interview","Offer","Rejected"}')
    expect(cells).toContain('MEDIAN(FILTER(')
    // Counted by Company: rows added by hand may have no Application ID.
    expect(cells).toContain('COUNTA(Applications!C:C)-1')
    expect(cells).toContain('SPARKLINE(')
    expect(cells).toContain('What stands out')
    // The Sankey: QuickChart draws it from the counts alone; gone: the verdict and waiting tables.
    const image = data.flatMap((d) => d.values.flat()).find((v) => typeof v === 'string' && v.startsWith('=IMAGE(')) as string
    expect(image).toContain('https://quickchart.io/chart?')
    expect(image).toContain("type:'sankey'")
    expect(image).toContain('ENCODEURL(')
    // No company, title or posting URL leaves the sheet: the company column is only ever counted.
    expect(image).not.toMatch(/Applications!(D|H):/)
    expect(image.replace(/COUNTA\(Applications!C:C\)/g, '')).not.toContain('Applications!C:C')
    expect(cells).not.toContain('Waiting longest')
    expect(cells).not.toContain('verdict, against answers')

    const merges = (dashboardRequests(7) as { mergeCells?: { range: Record<string, number> } }[])
      .flatMap((r) => (r.mergeCells ? [r.mergeCells.range] : []))
      .map((m) => [m.startRowIndex, m.endRowIndex, m.startColumnIndex, m.endColumnIndex])
    // Every block names only a start cell, no two blocks overlap, and none writes
    // under a merged cell (Sheets hides it, and an empty string there blocks a spill).
    const used = new Set<string>()
    const letters = Array.from({ length: DASH_COLS }, (_, i) => colName(i))
    for (const d of data) {
      const m = d.range.match(/^Dashboard!([A-Z]+)(\d+)$/)
      expect(m, d.range).not.toBeNull()
      const col0 = letters.indexOf(m![1])
      const row0 = Number(m![2]) - 1
      expect(col0).toBeGreaterThanOrEqual(0)
      d.values.forEach((row, r) =>
        row.forEach((v, c) => {
          const [y, x] = [row0 + r, col0 + c]
          const key = `${x}:${y}`
          expect(used.has(key), `${d.range} overlaps at ${key}`).toBe(false)
          expect(y).toBeLessThan(DASH_ROWS)
          used.add(key)
          const under = merges.find(([r0, r1, c0, c1]) => y >= r0 && y < r1 && x >= c0 && x < c1 && (y !== r0 || x !== c0))
          expect(under, `${d.range} writes under a merge at ${colName(x)}${y + 1}`).toBeUndefined()
          // Formulas at least balance their brackets and quotes.
          if (typeof v === 'string' && v.startsWith('=')) {
            const bare = v.replace(/"[^"]*"/g, '')
            expect((v.match(/"/g) ?? []).length % 2, v).toBe(0)
            for (const [o, cl] of ['()', '{}']) expect(bare.split(o).length, v).toBe(bare.split(cl).length)
          }
        }),
      )
    }
    // No two merges overlap either.
    merges.forEach((a, i) =>
      merges.slice(i + 1).forEach((b) => expect(a[0] < b[1] && b[0] < a[1] && a[2] < b[3] && b[2] < a[3], `${a} and ${b}`).toBe(false)),
    )

    const reqs = JSON.stringify(dashboardRequests(7))
    expect(reqs.match(/addChart/g)).toHaveLength(2)
    expect(reqs).toContain('gradientRule')
    expect(reqs).toContain('"hiddenByUser":true')
    // The cells go in the same batch, at the same places.
    const upd = dashboardCells(7) as { updateCells: { start: { rowIndex: number; columnIndex: number }; rows: { values: { userEnteredValue: object }[] }[] } }[]
    expect(upd).toHaveLength(data.length)
    expect(upd[0].updateCells.start).toEqual({ sheetId: 7, rowIndex: Number(data[0].range.match(/\d+$/)![0]) - 1, columnIndex: letters.indexOf(data[0].range.match(/!([A-Z]+)/)![1]) })
    const helper = upd.find((u) => u.updateCells.start.columnIndex === letters.indexOf('AH') && u.updateCells.start.rowIndex === 1)
    expect(Object.keys(helper!.updateCells.rows[0].values[0].userEnteredValue)).toEqual(['formulaValue'])
    const apps = JSON.stringify(appsRequests(0))
    expect(apps).toContain('frozenRowCount')
    expect(apps).toContain('ONE_OF_LIST')
  })
})

describe('statuses you type yourself', () => {
  it('reads other words and casing', async () => {
    const { readStatus } = await import('@/core/sheets/layout')
    expect(readStatus('rejected')).toBe('Rejected')
    expect(readStatus('Declined')).toBe('Rejected')
    expect(readStatus('Interviewing')).toBe('Interview')
    expect(readStatus(' OFFER ')).toBe('Offer')
    expect(readStatus('')).toBe('Applied')
  })
})

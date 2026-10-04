import { describe, expect, it } from 'vitest'
import { COLUMNS, dashboardData, dashboardRequests, parseRows, toRow } from '@/core/sheets/layout'
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
    expect(cells).toContain('COUNTIFS(Applications!B2:B')
    expect(cells).toContain('MEDIAN(FILTER(')
    expect(cells).toContain('Going stale')
    const cal = data.find((d) => d.range === 'Dashboard!I1:U8')!
    expect(cal.values).toHaveLength(8)
    expect(cal.values[1]).toHaveLength(13)
    const reqs = JSON.stringify(dashboardRequests(0, 1))
    expect(reqs).toContain('addChart')
    expect(reqs).toContain('gradientRule')
  })
})

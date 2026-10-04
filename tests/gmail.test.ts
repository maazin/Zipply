import { describe, expect, it } from 'vitest'
import { buildQuery, classifyEmail, matchApplication, nextStatus } from '@/core/gmail/rules'
import type { AppliedEntry } from '@/shared/types'
import { normalizeCompany } from '@/shared/text'

const app = (company: string, title: string, o: Partial<AppliedEntry> = {}): AppliedEntry => ({
  key: company, appId: company.slice(0, 3), company, companyNorm: normalizeCompany(company), title, jobId: '', url: '',
  dateApplied: '2026-09-20', status: 'Applied', firstReply: '', lastStatusChange: '', ...o,
})

describe('classifyEmail (ai-job-search gmail-sync phrases)', () => {
  it('reads each status', () => {
    expect(classifyEmail('Thank you for applying to Globex', 'We have received your application.')).toBe('Received')
    expect(classifyEmail('Next steps', 'Please complete your assessment on HackerRank within 5 days.')).toBe('Assessment')
    expect(classifyEmail('Interview', "We'd like to schedule a call with you next week.")).toBe('Interview')
    expect(classifyEmail('Offer', 'We are pleased to offer you the position.')).toBe('Offer')
    expect(classifyEmail('Your application', 'Unfortunately, we have decided to move forward with other candidates.')).toBe('Rejected')
  })
  it('treats conditional interview wording in an ack as an ack', () => {
    expect(classifyEmail('Application received', 'Thanks for applying! If your background is a match, we will reach out to schedule a call.')).toBe('Received')
  })
  it('returns null when nothing matches', () => {
    expect(classifyEmail('Newsletter', 'Our latest product news')).toBeNull()
  })
})

describe('nextStatus', () => {
  it('only moves forward', () => {
    expect(nextStatus('Interview', 'Received')).toEqual({ kind: 'noop' })
    expect(nextStatus('Applied', 'Interview')).toEqual({ kind: 'apply', to: 'Interview' })
  })
  it('allows Rejected from any open stage', () => {
    expect(nextStatus('Interview', 'Rejected')).toEqual({ kind: 'apply', to: 'Rejected' })
  })
  it('flags offers and conflicts', () => {
    expect(nextStatus('Interview', 'Offer').kind).toBe('offer')
    expect(nextStatus('Rejected', 'Interview').kind).toBe('conflict')
    expect(nextStatus('Offer', 'Rejected').kind).toBe('conflict')
  })
})

describe('matchApplication', () => {
  const open = [app('Globex, Inc.', 'Data Analyst I'), app('Initech', 'Data Engineer'), app('Acme Corp', 'Analyst')]
  it('matches by sender domain', () => {
    expect(matchApplication({ from: 'Recruiting <jobs@globex.com>', subject: 'Hi', body: 'Hello' }, open).entry?.company).toBe('Globex, Inc.')
  })
  it('matches ATS mail by company name in the body', () => {
    expect(matchApplication({ from: 'no-reply@greenhouse.io', subject: 'Your application', body: 'Thank you for applying to Initech.' }, open).entry?.company).toBe('Initech')
  })
  it('refuses to guess between two equal candidates', () => {
    const r = matchApplication({ from: 'no-reply@lever.co', subject: 'Update', body: 'Globex and Initech are partners.' }, open)
    expect(r.entry).toBeNull()
    expect(r.candidates).toHaveLength(2)
  })
  it('returns nothing for unrelated mail', () => {
    expect(matchApplication({ from: 'news@example.com', subject: 'Deals', body: 'Sale' }, open).entry).toBeNull()
  })
})

describe('buildQuery', () => {
  it('limits to 30 days, excludes sent mail, includes ATS senders and companies', () => {
    const q = buildQuery(['Globex', 'Initech'])
    expect(q).toMatch(/^newer_than:30d -in:sent -in:drafts/)
    expect(q).toContain('from:greenhouse.io')
    expect(q).toContain('"Globex"')
  })
})

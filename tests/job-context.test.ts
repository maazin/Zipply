import { describe, expect, it } from 'vitest'
import { continuesJob, JOB_TTL, mergePostingInto, titlesMatch } from '@/core/jobContext'
import { canonicalUrl } from '@/core/score/applied'
import { sinceSummary } from '@/sidepanel/since'
import { posting } from './helpers'

const DESC = 'About the role. Requirements: SQL, Python, Tableau. '.repeat(12)
const linkedin = posting({ title: 'Data Analyst', company: 'Globex', description: DESC, jobId: '111', url: 'https://www.linkedin.com/jobs/view/111/' })

describe('following one job from the posting to the application', () => {
  it('keeps the job when the application form has no description of its own', () => {
    const form = posting({ title: 'Apply', company: '', description: '', url: 'https://boards.greenhouse.io/globex/jobs/4012345' })
    expect(continuesJob({ posting: linkedin, at: Date.now() }, form)).toBe(true)
    const merged = mergePostingInto(linkedin, form)
    expect(merged).toMatchObject({ title: 'Data Analyst', company: 'Globex', url: linkedin.url })
    expect(merged.description).toBe(DESC)
  })

  it('keeps the job when the form names the same role, and fills in what was missing', () => {
    const form = posting({ title: 'Apply for Data Analyst (Remote)', company: 'Globex', location: 'Remote', description: 'Short blurb.', url: 'https://globex.com/careers/apply' })
    expect(continuesJob({ posting: { ...linkedin, location: '' }, at: Date.now() }, form)).toBe(true)
    expect(mergePostingInto({ ...linkedin, location: '' }, form).location).toBe('Remote')
  })

  it('starts a new job for a different posting with its own description', () => {
    const other = posting({ title: 'Staff Engineer', company: 'Initech', description: DESC, url: 'https://initech.com/jobs/9' })
    expect(continuesJob({ posting: linkedin, at: Date.now() }, other)).toBe(false)
    const sameCompany = posting({ title: 'Product Designer', company: 'Globex', description: DESC, url: 'https://globex.com/jobs/2' })
    expect(continuesJob({ posting: linkedin, at: Date.now() }, sameCompany)).toBe(false)
  })

  it('after you filled a form, a named job on another site is a new application', () => {
    const greenhouse = posting({ title: 'Data Analyst I', company: 'Globex', description: '', url: 'https://boards.greenhouse.io/globex/jobs/1' })
    const lever = posting({ title: 'Data Analyst', company: 'Initech', description: '', url: 'https://jobs.lever.co/initech/2/apply' })
    expect(continuesJob({ posting: greenhouse, at: Date.now(), filledAt: Date.now(), lastUrl: greenhouse.url }, lever)).toBe(false)
    // Before filling, the same move is just "Apply" taking you to the form.
    expect(continuesJob({ posting: greenhouse, at: Date.now(), lastUrl: greenhouse.url }, { ...lever, title: '', company: '' })).toBe(true)
  })

  it('keeps going through the steps of a form on the same site after filling', () => {
    const step1 = posting({ title: 'Data Analyst', company: 'Globex', description: DESC, url: 'https://globex.wd5.myworkdayjobs.com/job/123' })
    const step2 = posting({ title: 'My Experience', company: '', description: '', url: 'https://globex.wd5.myworkdayjobs.com/job/123/apply/step2' })
    expect(continuesJob({ posting: step1, at: Date.now(), filledAt: Date.now(), lastUrl: step1.url }, step2)).toBe(true)
  })

  it('treats two job IDs on one site as two jobs', () => {
    const a = posting({ title: 'Data Analyst', company: 'Globex', jobId: '1', description: '', url: 'https://boards.greenhouse.io/globex/jobs/1' })
    const b = posting({ title: 'Data Analyst', company: '', jobId: '2', description: '', url: 'https://boards.greenhouse.io/globex/jobs/2' })
    expect(continuesJob({ posting: a, at: Date.now(), lastUrl: a.url }, b)).toBe(false)
  })

  it('once a job is logged, the next form you open is another job', () => {
    const a = posting({ title: 'Junior Data Engineer', company: 'Initech', jobId: '', description: '', url: 'https://www.hooli.com/careers/apply' })
    const b = posting({ title: 'Product Designer', company: 'Initech', jobId: '', description: '', url: 'https://www.hooli.com/careers/design/apply' })
    const prev = { posting: a, at: Date.now(), filledAt: Date.now(), lastUrl: a.url }
    expect(continuesJob(prev, b)).toBe(true)
    expect(continuesJob({ ...prev, loggedAppId: 'abc123' }, b)).toBe(false)
    // The same posting is still that job.
    expect(continuesJob({ ...prev, loggedAppId: 'abc123' }, { ...a })).toBe(true)
  })

  it('lets an hours-old job go', () => {
    const form = posting({ title: '', company: '', description: '', url: 'https://example.com/apply' })
    expect(continuesJob({ posting: linkedin, at: Date.now() - JOB_TTL - 1 }, form)).toBe(false)
    // The very same posting always continues.
    expect(continuesJob({ posting: linkedin, at: Date.now() - JOB_TTL - 1 }, { ...linkedin })).toBe(true)
  })

  it('matches titles with extra words around them, not unrelated ones', () => {
    expect(titlesMatch('Senior Data Analyst', 'Apply: Senior Data Analyst - Tampa')).toBe(true)
    expect(titlesMatch('Data Analyst', 'Data Engineer')).toBe(false)
    expect(titlesMatch('', 'Data Analyst')).toBe(false)
  })
})

describe('since last time', () => {
  it('says it in one line', () => {
    expect(sinceSummary({ offers: 1, updates: 12, conflicts: 0, unlogged: 3, emails: 1 })).toBe('1 offer · 12 status updates · 3 to log · 1 email to sort')
    expect(sinceSummary({ offers: 0, updates: 1, conflicts: 2, unlogged: 0, emails: 0 })).toBe('1 status update · 2 to check')
  })
})

describe('one address per job', () => {
  it('drops the apply step, but not a job number that comes after it', () => {
    expect(canonicalUrl('https://jobs.lever.co/globex/1b2c3d4e/apply?lever-source=LinkedIn')).toBe('https://jobs.lever.co/globex/1b2c3d4e')
    expect(canonicalUrl('https://acme.wd5.myworkdayjobs.com/job/NYC/Analyst_R123/apply/applyManually')).toBe('https://acme.wd5.myworkdayjobs.com/job/NYC/Analyst_R123')
    expect(canonicalUrl('https://careers.acme.com/apply/48213')).toBe('https://careers.acme.com/apply/48213')
    expect(canonicalUrl('https://careers.acme.com/apply/48213')).not.toBe(canonicalUrl('https://careers.acme.com/apply/51007'))
    expect(canonicalUrl('https://www.hooli.com/careers/apply')).toBe('https://www.hooli.com/careers')
  })
})

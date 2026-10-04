import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FillContext } from '@/shared/messages'
import { collectFields } from '@/content/dom/collect'
import { fillPage } from '@/content/fill'
import { pickAdapter } from '@/content/adapters'
import { workday, postedOn } from '@/content/adapters/workday'
import { mergePosting, postingFromJsonLd, genericPosting } from '@/content/posting'
import { profile } from './helpers'

const sent: unknown[] = []
;(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: { sendMessage: vi.fn(async (m: unknown) => (sent.push(m), {})) },
}

function load(name: string, url: string) {
  const html = readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
  const doc = new DOMParser().parseFromString(html, 'text/html')
  document.head.innerHTML = doc.head.innerHTML
  document.body.innerHTML = doc.body.innerHTML
  // Run inline fixture scripts (they simulate the ATS widgets).
  for (const s of Array.from(doc.querySelectorAll('body script'))) new Function(s.textContent ?? '')()
  return new URL(url)
}

function ctx(): FillContext {
  const p = profile()
  p.work.unshift({ id: 'w0', title: 'Analyst', company: 'Initech', location: 'Remote', start: '2025-09', end: '', current: true, description: 'Pipelines' })
  return { profile: p, bank: [], resume: null, threshold: 0.75, autoDraft: false, aiReady: false, posting: null }
}

const val = (sel: string) => (document.querySelector(sel) as HTMLInputElement).value

beforeEach(() => {
  sent.length = 0
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('Greenhouse', () => {
  it('detects the ATS and fills the form', async () => {
    const url = load('greenhouse.html', 'https://boards.greenhouse.io/globex/jobs/4012345')
    const adapter = pickAdapter(url, document)
    expect(adapter.name).toBe('Greenhouse')
    const reports = await fillPage(adapter, ctx(), document)
    expect(val('#first_name')).toBe('Ada')
    expect(val('#last_name')).toBe('Lovelace')
    expect(val('#email')).toBe('ada@example.com')
    expect(val('#q1')).toBe('https://linkedin.com/in/ada')
    expect((document.querySelector('#q3') as HTMLSelectElement).selectedOptions[0].text).toBe('Yes')
    expect((document.querySelector('#q4') as HTMLSelectElement).selectedOptions[0].text).toBe('No')
    expect((document.querySelector('#gender') as HTMLSelectElement).selectedOptions[0].text).toBe('Decline To Self Identify')
    expect((document.querySelector('#veteran_status') as HTMLSelectElement).selectedOptions[0].text).toBe("I don't wish to answer")
    // Never ticks the consent box, never touches the open question without AI.
    expect((document.querySelector('#q6') as HTMLInputElement).checked).toBe(false)
    expect(val('#q5')).toBe('')
    const filled = reports.filter((r) => r.status === 'filled').length
    expect(filled).toBeGreaterThanOrEqual(8)
  }, 20000)

  it('reads the posting from double-escaped JSON-LD and the URL', async () => {
    const url = load('greenhouse.html', 'https://boards.greenhouse.io/globex/jobs/4012345')
    const adapter = pickAdapter(url, document)
    const p = mergePosting(url.href, postingFromJsonLd(document), await adapter.posting!(document, url))
    expect(p).toMatchObject({ title: 'Data Analyst I', company: 'Globex', location: 'Tampa, FL', jobId: '4012345', datePosted: '2026-09-20' })
    expect(p.description).toContain('SQL and Python')
    expect(p.description).not.toContain('<li>')
  })
})

describe('Lever', () => {
  it('fills full name, links and EEO', async () => {
    const url = load('lever.html', 'https://jobs.lever.co/globex/1b2c3d4e/apply')
    const adapter = pickAdapter(url, document)
    expect(adapter.name).toBe('Lever')
    await fillPage(adapter, ctx(), document)
    expect(val('input[name="name"]')).toBe('Ada Lovelace')
    expect(val('input[name="org"]')).toBe('Initech')
    expect(val('input[name="urls[GitHub]"]')).toBe('https://github.com/ada')
    expect((document.querySelector('select[name="eeo[gender]"]') as HTMLSelectElement).selectedOptions[0].text).toBe('Decline to self-identify')
    // A skill-specific years question is not "total years of experience".
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=radio]'))
    expect(radios.filter((r) => r.checked).length).toBeLessThanOrEqual(1)
  }, 20000)
})

describe('Workday', () => {
  it('adds work blocks, fills dates, custom dropdowns and explicit fields', async () => {
    const url = load('workday.html', 'https://globex.wd5.myworkdayjobs.com/en-US/careers/job/Tampa/Data-Analyst-I_R-100/apply/applyManually')
    const adapter = pickAdapter(url, document)
    expect(adapter.name).toBe('Workday')
    const c = ctx()
    const reports = await fillPage(adapter, c, document)
    const titles = Array.from(document.querySelectorAll<HTMLInputElement>('[data-automation-id="jobTitle"]')).map((i) => i.value)
    expect(titles).toEqual(['Analyst', 'Data Analyst Intern'])
    const companies = Array.from(document.querySelectorAll<HTMLInputElement>('[data-automation-id="company"]')).map((i) => i.value)
    expect(companies).toEqual(['Initech', 'Acme Corp'])
    expect((document.querySelector('#cw1') as HTMLInputElement).checked).toBe(true)
    const years = Array.from(document.querySelectorAll<HTMLInputElement>('[data-automation-id="dateSectionYear-input"]')).map((i) => i.value)
    expect(years).toEqual(['2025', '', '2025', '2025'])
    expect(val('#fn')).toBe('Ada')
    expect(val('#ph')).toBe('(813) 555-0100')
    expect(val('#li')).toBe('https://linkedin.com/in/ada')
    expect(document.querySelector('[data-automation-id="countryDropdown"]')!.textContent).toBe('United States of America')
    expect(reports.some((r) => r.label.startsWith('Work 2'))).toBe(true)
  }, 30000)

  it('parses "Posted 30+ Days Ago"', () => {
    expect(postedOn('Posted 30+ Days Ago', new Date('2026-10-04T12:00:00Z'))).toBe('2026-09-04')
    expect(postedOn('Posted Yesterday', new Date('2026-10-04T12:00:00Z'))).toBe('2026-10-03')
  })

  it('reads the job ID from the URL', async () => {
    const url = load('workday.html', 'https://globex.wd5.myworkdayjobs.com/en-US/careers/job/Tampa/Data-Analyst-I_R-100')
    const p = await workday.posting!(document, url)
    expect(p.jobId).toBe('R-100')
    expect(p.company).toBe('Globex')
  })
})

describe('Fallback on a company-built form', () => {
  it('uses the rule-based matcher and never guesses salary', async () => {
    const url = load('custom.html', 'https://careers.initech.com/jobs/42')
    const adapter = pickAdapter(url, document)
    expect(adapter.name).toBe('Other')
    const reports = await fillPage(adapter, ctx(), document)
    expect(val('input[name="applicant_given"]')).toBe('Ada')
    expect(val('input[name="contact"]')).toBe('ada@example.com')
    expect(val('input[name="mob"]')).toBe('(813) 555-0100')
    expect(val('input[name="pc"]')).toBe('33602')
    expect(val('input[name="applicant_surname"]')).toBe('Lovelace')
    expect(val('input[name="sal"]')).toBe('')
    expect(reports.find((r) => r.label === 'Desired salary')?.status).toBe('skipped')
  }, 20000)

  it('reads a generic posting', () => {
    load('custom.html', 'https://careers.initech.com/jobs/42')
    const g = genericPosting(document)
    expect(g.title).toBe('Junior Data Engineer')
    expect(g.company).toBe('Initech')
    expect(g.description).toContain('Airflow')
  })

  it('collects every field with a label', () => {
    load('custom.html', 'https://careers.initech.com/jobs/42')
    const labels = collectFields(document).map((c) => c.desc.label || c.desc.nearbyText)
    expect(labels).toEqual(expect.arrayContaining(['Given name', 'E-mail address', 'Surname']))
  })
})

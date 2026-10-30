import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FillContext } from '@/shared/messages'
import type { FieldReport } from '@/shared/types'
import { collectFields } from '@/content/dom/collect'
import { fillPage } from '@/content/fill'
import { pickAdapter } from '@/content/adapters'
import { workday, postedOn } from '@/content/adapters/workday'
import { mergePosting, postingFromJsonLd, genericPosting } from '@/content/posting'
import { oracleJob } from '@/content/adapters/oracle'
import { companyFromSiteName } from '@/shared/text'
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
    const filled = reports.filter((r) => r.status !== 'skipped').length
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

  it("reads only the description, not the menus, cookie banner, similar jobs or footer around it", () => {
    document.body.innerHTML = `
      <header><nav><a>Jobs</a><a>Kubernetes blog</a></nav></header>
      <div class="cookie-banner">We use cookies and Salesforce analytics.</div>
      <main>
        <h1>Data Analyst</h1>
        <div class="layout">
          <article class="job-description">
            <h3>Responsibilities</h3><p>Turn data into decisions for the operations team every day.</p>
            <h3>Requirements</h3><ul><li>2+ years of experience with SQL</li><li>Python</li></ul>
            <button>Apply now</button>
          </article>
          <aside><h3>Similar jobs</h3><p>Senior Designer, requirements: Figma and Kubernetes</p></aside>
        </div>
        <section><h3>Similar jobs</h3><p>Backend Engineer. Requirements: Go and AWS.</p></section>
        <form><label>First name <input></label><label>LinkedIn profile <input></label></form>
      </main>
      <footer>Privacy policy · Careers at Globex · Tableau</footer>`
    const d = genericPosting(document).description!
    expect(d).toContain('SQL')
    expect(d).toContain('Turn data into decisions')
    for (const noise of ['cookies', 'Kubernetes', 'Salesforce', 'Figma', 'Backend Engineer', 'AWS', 'First name', 'LinkedIn', 'Privacy', 'Tableau', 'Apply now'])
      expect(d).not.toContain(noise)
  })

  it('stops filling when you pause, leaving the rest as it was', async () => {
    const url = load('custom.html', 'https://careers.initech.com/jobs/42')
    // You press Pause as soon as the first field is filled.
    const reports = await fillPage(pickAdapter(url, document), ctx(), document, new Set(), {
      stopped: () => Array.from(document.querySelectorAll('input')).some((i) => i.value),
    })
    // The first field filled; the pause landed before the next.
    const filled = reports.filter((r) => r.status !== 'skipped')
    expect(filled.length).toBe(1)
    expect(reports.filter((r) => r.reason === 'Paused').length).toBeGreaterThan(2)
    expect(val('input[name="pc"]')).toBe('')
  }, 20000)

  it('collects every field with a label', () => {
    load('custom.html', 'https://careers.initech.com/jobs/42')
    const labels = collectFields(document).map((c) => c.desc.label || c.desc.nearbyText)
    expect(labels).toEqual(expect.arrayContaining(['Given name', 'E-mail address', 'Surname']))
  })
})

describe('Oracle Recruiting Cloud', () => {
  const ORACLE = 'https://globex.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/2107/apply/section/1'

  it('reads yes/no pills, hidden radio labels and grid dropdowns', () => {
    const url = load('oracle.html', ORACLE)
    expect(pickAdapter(url, document).name).toBe('Oracle')
    const fields = collectFields(document)
    const auth = fields.find((f) => /legally authorized/.test(f.desc.label))!
    expect(auth.desc).toMatchObject({ kind: 'radio', options: ['Yes', 'No'] })
    expect(fields.find((f) => /sponsorship/.test(f.desc.label))?.desc.options).toEqual(['Yes', 'No'])
    // The words are aria-hidden, but they're still what the option says.
    expect(fields.find((f) => f.desc.label === 'Veteran Status')?.desc.options).toEqual(['I am a protected veteran', 'I am not a protected veteran', 'I do not wish to self-identify'])
    expect(fields.find((f) => f.desc.label === 'Country')?.desc.kind).toBe('combobox')
    // Not the honeypot, not the chat assistant.
    expect(fields.some((f) => /honey|Ask Me/i.test(`${f.desc.label} ${f.desc.name} ${f.desc.ariaLabel}`))).toBe(false)
  })

  it('fills the form, pressing the pills and picking from the grid', async () => {
    const url = load('oracle.html', ORACLE)
    const reports = await fillPage(pickAdapter(url, document), ctx(), document)
    expect(val('#firstName-7')).toBe('Ada')
    expect(val('#lastName-8')).toBe('Lovelace')
    expect(val('#email-9')).toBe('ada@example.com')
    expect((document.querySelector('#country-10') as HTMLInputElement).dataset.selected).toBe('United States')
    const pressed = (q: RegExp) =>
      Array.from(document.querySelectorAll('ul[role="radiogroup"]'))
        .find((u) => q.test(u.getAttribute('aria-label') ?? ''))!
        .querySelector('[aria-checked="true"]')?.textContent?.trim()
    expect(pressed(/authorized/)).toBe('Yes')
    expect(pressed(/sponsorship/)).toBe('No')
    expect((document.querySelector('#vet-3') as HTMLInputElement).checked).toBe(true)
    // Terms stay yours to accept.
    expect((document.querySelector('#af-checkbox-terms') as HTMLInputElement).checked).toBe(false)
    // Work authorization answers are filled but flagged for you to check, as on every site.
    expect(reports.filter((r) => r.status === 'filled' || r.status === 'low').length).toBe(7)
  }, 20000)

  it('reads the job from the site API, with the employer instead of the site name', async () => {
    const url = load('oracle.html', ORACLE)
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({
        items: [
          {
            Id: '2107',
            Title: 'Data Analyst',
            PrimaryLocation: 'Tampa, FL, United States',
            WorkplaceType: 'Hybrid',
            JobSchedule: 'Full time',
            ExternalPostedStartDate: '2026-10-21T08:36:47+00:00',
            ExternalDescriptionStr: '<p>Turn data into decisions.</p>',
            ExternalQualificationsStr: '<ul><li>SQL and Python</li><li>Tableau</li></ul>',
          },
        ],
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const p = await pickAdapter(url, document).posting!(document, url)
      expect(String(fetchMock.mock.calls[0][0])).toBe(
        'https://globex.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%222107%22,siteNumber=CX_1001',
      )
      expect(p).toMatchObject({ title: 'Data Analyst', company: 'Globex', jobId: '2107', datePosted: '2026-10-21', workMode: 'hybrid', employmentType: 'Full time' })
      expect(p.description).toContain('SQL and Python')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('finds the job on a company domain too', () => {
    expect(oracleJob(new URL('https://careers.oracle.com/en/sites/jobsearch/job/309111'))).toEqual({ site: 'jobsearch', id: '309111' })
    expect(oracleJob(new URL(ORACLE))).toEqual({ site: 'CX_1001', id: '2107' })
    expect(oracleJob(new URL('https://globex.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/jobs'))).toBeNull()
  })
})

describe('AI drafts', () => {
  it("don't hold up the fill: it returns, and each draft arrives after", async () => {
    const url = load('custom.html', 'https://careers.initech.com/jobs/42')
    let answer: (v: unknown) => void = () => undefined
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (m: { type: string }) => (m.type === 'ai:answer' ? new Promise((r) => (answer = r)) : m.type === 'ai:map' ? { mappings: [] } : {}))
    const drafted: FieldReport[][] = []
    try {
      const reports = await fillPage(pickAdapter(url, document), { ...ctx(), autoDraft: true, aiReady: true }, document, new Set(), { onDrafts: (r) => drafted.push(r) })
      // The model hasn't answered, yet the fill is done.
      expect(val('input[name="applicant_given"]')).toBe('Ada')
      expect(reports.find((r) => /project/i.test(r.label))?.reason).toBe('Writing a draft…')
      answer({ text: 'I built a pipeline that cut load times in half.', model: 'test', warnings: [] })
      await vi.waitFor(() => expect(drafted).toHaveLength(1))
      expect(drafted[0][0]).toMatchObject({ status: 'draft', source: 'ai-draft' })
      expect(val('textarea[name="proj"]')).toMatch(/pipeline/)
    } finally {
      send.mockImplementation(async (m: unknown) => (sent.push(m), {}))
    }
  })
})

describe('searchable dropdowns', () => {
  it('picks from the whole list, so other wording than your saved answer still matches', async () => {
    const { setCombobox } = await import('@/content/dom/setValue')
    // Like React-Select: typing shows only options containing what you typed.
    document.body.innerHTML = `<div id="dd"><input role="combobox" aria-controls="list"></div><div id="list" role="listbox"></div>`
    const input = document.querySelector('input')!
    const all = ['Yes, I have a disability (or previously had a disability)', 'No, I do not have a disability and have not had one in the past', 'I do not want to answer']
    let chosen = ''
    const render = () => {
      const q = input.value.toLowerCase()
      document.getElementById('list')!.innerHTML = all.filter((o) => o.toLowerCase().includes(q)).map((o) => `<div role="option">${o}</div>`).join('')
      document.querySelectorAll<HTMLElement>('[role=option]').forEach((o) => (o.onclick = () => (chosen = o.textContent!)))
    }
    input.addEventListener('mousedown', render)
    input.addEventListener('input', render)
    expect(await setCombobox(input, "No, I don't have a disability")).toMatch(/^No, I do not/)
    expect(chosen).toMatch(/^No, I do not/)
  })
  it('types to search when the list starts empty, and clears what it typed when nothing matches', async () => {
    const { setCombobox } = await import('@/content/dom/setValue')
    document.body.innerHTML = `<input role="combobox" aria-controls="list"><div id="list" role="listbox"></div>`
    const input = document.querySelector('input')!
    const schools = ['University of South Florida', 'University of Florida']
    input.addEventListener('input', () => {
      const q = input.value.toLowerCase()
      document.getElementById('list')!.innerHTML = q ? schools.filter((o) => o.toLowerCase().includes(q)).map((o) => `<div role="option">${o}</div>`).join('') : ''
    })
    expect(await setCombobox(input, 'University of South Florida')).toBe('University of South Florida')
    expect(await setCombobox(input, 'Hogwarts')).toBeNull()
    expect(input.value).toBe('')
  })
})

describe('links', () => {
  it('gets an https:// so forms accept it', async () => {
    const { fullUrl } = await import('@/shared/profileKeys')
    expect(fullUrl('linkedin.com/in/ada')).toBe('https://linkedin.com/in/ada')
    expect(fullUrl('www.ada.dev')).toBe('https://www.ada.dev')
    expect(fullUrl('https://github.com/ada')).toBe('https://github.com/ada')
    expect(fullUrl('')).toBe('')
    expect(fullUrl('ada lovelace')).toBe('ada lovelace')
  })
})

describe('career-site names', () => {
  it('keeps the employer', () => {
    expect(companyFromSiteName('JPMC Candidate Experience page')).toBe('JPMC')
    expect(companyFromSiteName('Careers at Globex')).toBe('Globex')
    expect(companyFromSiteName('Initech Careers')).toBe('Initech')
    expect(companyFromSiteName('Globex - External Career Site')).toBe('Globex')
    expect(companyFromSiteName('Career Education Corp')).toBe('Career Education Corp')
    expect(companyFromSiteName('Careers')).toBe('Careers')
  })
})

describe('Handshake applications', () => {
  it('reads the My jobs table', async () => {
    const { handshakeApplications } = await import('@/content/listings')
    document.body.innerHTML = `<table><tr data-hook="row-1"><td><a href="/jobs/11517102" aria-label="Employer, Avery. Title, Analyst. Location, Onsite, based in Miami, FL. Applied, 10/26/2026. Status, Applied"></a></td><td headers="employerName"><div><p>Avery</p><p data-hook="lockup-subheading">Internet &amp; Software</p></div></td><td headers="title"><span>Analyst</span></td><td headers="location"><span>Onsite, based in Miami, FL</span></td><td headers="applicationDate"><span>10/26/2026</span></td><td headers="status"><span>Applied</span></td></tr>
      <tr><td><a href="/jobs/2" aria-label="Employer, Globex, Inc.. Title, Data Analyst, Tech. Location, Remote. Applied, 10/20/2026. Status, Applied"></a></td></tr></table>`
    const rows = handshakeApplications(document)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ date: '2026-10-26', posting: { company: 'Avery', title: 'Analyst', jobId: '11517102', location: 'Onsite, based in Miami, FL', url: 'https://app.joinhandshake.com/jobs/11517102' } })
    // Only the link's label to go on.
    expect(rows[1]).toMatchObject({ date: '2026-10-20', posting: { company: 'Globex, Inc.', title: 'Data Analyst, Tech', location: 'Remote' } })
  })

  it('reads "Applied on" only for the job the pane shows', async () => {
    const { SITES } = await import('@/content/listings')
    const hs = SITES.find((s) => s.name === 'Handshake')!
    document.body.innerHTML = `<div data-hook="right-content"><a href="/jobs/333"><h1>ML Engineer</h1></a><div><h2>Applied on October 26, 2026</h2></div></div>`
    expect(hs.appliedOn!(document, '333')).toBe('2026-10-26')
    // Still the last job's pane while the next one loads.
    expect(hs.appliedOn!(document, '444')).toBe('')
  })
})

describe('SmartRecruiters (fields inside web components)', () => {
  const SR = 'https://jobs.smartrecruiters.com/oneclick-ui/company/Globex/publication/273278e1-db5f-42fc-b185-71d233cc85b5'
  const inner = (hostId: string) => document.getElementById(hostId)!.shadowRoot!.querySelector('input, textarea') as HTMLInputElement

  it('finds the fields inside shadow roots, with their labels', async () => {
    const url = load('smartrecruiters.html', SR)
    const { detectApplication } = await import('@/content/detect')
    expect(document.querySelectorAll('input').length).toBe(0)
    expect(pickAdapter(url, document).name).toBe('SmartRecruiters')
    expect(detectApplication(document, new URL('https://careers.globex.com/apply')).isApplication).toBe(true)
    const fields = collectFields(document)
    const labels = fields.map((f) => `${f.desc.kind}:${f.desc.label}`)
    expect(labels).toEqual(
      expect.arrayContaining(['file:Choose a file or drop it here', 'text:First name', 'email:Confirm your email', 'combobox:City', 'textarea:Let the company know about your interest']),
    )
    expect(fields.find((f) => f.desc.label === 'First name')?.desc.required).toBe(true)
  })

  it('fills them and picks the city from the component’s own list', async () => {
    const url = load('smartrecruiters.html', SR)
    const reports = await fillPage(pickAdapter(url, document), ctx(), document)
    expect(inner('first-name-input').value).toBe('Ada')
    expect((document.getElementById('first-name-input') as HTMLElement & { value?: string }).value).toBe('Ada')
    expect(inner('last-name-input').value).toBe('Lovelace')
    expect(inner('email-input').value).toBe('ada@example.com')
    expect(inner('confirm-email-input').value).toBe('ada@example.com')
    expect(document.getElementById('city-input')!.dataset.selected).toMatch(/^Tampa/)
    expect(reports.find((r) => r.label === 'First name')?.status).toBe('filled')
  }, 20000)

  it('reads the job from the public postings API', async () => {
    const url = load('smartrecruiters.html', SR)
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({
        id: '744000156841854',
        name: 'Data Analyst',
        company: { name: 'Globex', identifier: 'Globex' },
        location: { city: 'Tampa', region: 'Florida', fullLocation: 'Tampa, Florida, United States', remote: false, hybrid: true },
        releasedDate: '2026-10-21T15:44:30.178Z',
        typeOfEmployment: { label: 'Full-time' },
        jobAd: { sections: { jobDescription: { text: '<p>Build dashboards in Tableau and SQL.</p>' }, qualifications: { text: '<ul><li>Python</li></ul>' } } },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const p = await pickAdapter(url, document).posting!(document, url)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.smartrecruiters.com/v1/companies/Globex/postings/273278e1-db5f-42fc-b185-71d233cc85b5')
    expect(p).toMatchObject({ title: 'Data Analyst', company: 'Globex', location: 'Tampa, Florida, United States', jobId: '744000156841854', workMode: 'hybrid', datePosted: '2026-10-21' })
    expect(p.description).toContain('Tableau')
    vi.unstubAllGlobals()
  })
})

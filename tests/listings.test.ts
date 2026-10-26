import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearStale, decorateCards, isListingHost, listingPosting, placePill, siteFor, type ListingScore } from '@/content/listings'

function load(name: string) {
  const doc = new DOMParser().parseFromString(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'), 'text/html')
  document.body.innerHTML = doc.body.innerHTML
}

const score: ListingScore = { score: 78, verdict: 'Apply', reason: 'Strong match', applied: false }

describe('listing sites', () => {
  it('recognizes LinkedIn job pages and Indeed, and nothing else', () => {
    expect(siteFor(new URL('https://www.linkedin.com/jobs/search/?currentJobId=111'))?.name).toBe('LinkedIn')
    expect(siteFor(new URL('https://www.linkedin.com/feed/'))).toBeNull()
    expect(siteFor(new URL('https://www.indeed.com/jobs?q=analyst&vjk=abc123'))?.name).toBe('Indeed')
    expect(siteFor(new URL('https://example.com/jobs'))).toBeNull()
  })

  it('reads the open LinkedIn job from the detail pane', () => {
    load('linkedin.html')
    const url = new URL('https://www.linkedin.com/jobs/search/?currentJobId=111')
    const p = listingPosting(siteFor(url)!, document, url)
    expect(p).toMatchObject({ title: 'Data Analyst', company: 'Globex', location: 'Tampa, FL', jobId: '111', url: 'https://www.linkedin.com/jobs/view/111/' })
    expect(p!.description).toContain('SQL and Python')
  })

  it('reads the open Indeed job', () => {
    load('indeed.html')
    const url = new URL('https://www.indeed.com/jobs?q=analyst&vjk=abc123')
    expect(listingPosting(siteFor(url)!, document, url)).toMatchObject({ title: 'Data Analyst', company: 'Globex', jobId: 'abc123' })
  })

  it('waits until the description has loaded', () => {
    load('linkedin.html')
    document.querySelector('#job-details')!.innerHTML = ''
    const url = new URL('https://www.linkedin.com/jobs/search/?currentJobId=111')
    expect(listingPosting(siteFor(url)!, document, url)).toBeNull()
  })

  it('puts one pill on scored cards only, and refreshes instead of stacking', () => {
    load('linkedin.html')
    const site = siteFor(new URL('https://www.linkedin.com/jobs/search/'))!
    const scores = new Map([['111', score]])
    decorateCards(site, document, scores)
    decorateCards(site, document, scores)
    expect(document.querySelectorAll('[data-zipply-pill="111"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-zipply-pill="222"]')).toHaveLength(0)
    const pillEl = document.querySelector('[data-zipply-pill="111"]')!
    expect(pillEl.shadowRoot!.textContent).toBe('78 · Apply')
    const title = document.querySelector(site.title)
    placePill(title, '111', { ...score, applied: true })
    placePill(title, '111', { ...score, applied: true })
    // Inside the heading, on the title's line, and the title still reads cleanly.
    expect(document.querySelector('h1 > [data-zipply-pill="111"]')).not.toBeNull()
    const url = new URL('https://www.linkedin.com/jobs/search/?currentJobId=111')
    expect(listingPosting(siteFor(url)!, document, url)!.title).toBe('Data Analyst')
    expect(document.querySelectorAll('.jobs-search__job-details--container [data-zipply-pill]')).toHaveLength(1)
    expect(document.querySelector('.jobs-search__job-details--container [data-zipply-pill]')!.shadowRoot!.textContent).toBe('Applied')
  })

  it('swaps the pill when another job opens in the same pane or card', () => {
    load('linkedin.html')
    const site = siteFor(new URL('https://www.linkedin.com/jobs/search/'))!
    const title = document.querySelector(site.title)!
    placePill(title, '111', score)
    // LinkedIn reuses the title element: while job 222 loads, the old pill goes.
    clearStale(title, '222')
    expect(document.querySelectorAll('.jobs-search__job-details--container [data-zipply-pill]')).toHaveLength(0)
    placePill(title, '222', { ...score, score: 40, verdict: 'Skip' })
    const pills = document.querySelectorAll('.jobs-search__job-details--container [data-zipply-pill]')
    expect(pills).toHaveLength(1)
    expect(pills[0].getAttribute('data-zipply-pill')).toBe('222')
    // A recycled card that now shows job 222 loses job 111's pill.
    decorateCards(site, document, new Map([['111', score]]))
    const card = document.querySelector('[data-occludable-job-id="111"]')!
    card.setAttribute('data-occludable-job-id', '333')
    card.querySelector('[data-job-id]')!.setAttribute('data-job-id', '333')
    decorateCards(site, document, new Map([['111', score]]))
    expect(card.querySelectorAll('[data-zipply-pill]')).toHaveLength(0)
  })
})

describe('Handshake', () => {
  const pane = (company: string, title: string, desc: string) => `
    <h1>Jobs</h1>
    <div data-hook="job-result-card | 111"><div><span>Globex</span><div>Data Analyst</div><div>Full-time</div></div></div>
    <div data-hook="job-result-card | 222"><div><span>Initech</span><div>Backend Engineer</div></div></div>
    <div data-hook="right-content">
      <div><a href="/e/1"><img alt=""></a><a href="/e/1">${company}</a></div>
      <a href="/jobs/111"><h1>${title}</h1></a>
      <div><h3>At a glance</h3><div>Full-time</div></div>
      <div><div><h3>Job description</h3></div><div><p>${desc}</p></div></div>
      <div><h3>What they're looking for</h3><p>SQL and Python.</p></div>
      <div><h3>About the employer</h3><p>Not part of the job.</p></div>
    </div>`
  const DESC = 'Turn scheduling data into decisions for operations leaders, with dashboards in Tableau on SQL.'

  it('reads the job in the right-hand pane, not the page heading', () => {
    document.body.innerHTML = pane('Globex', 'Data Analyst', DESC)
    const url = new URL('https://app.joinhandshake.com/job-search/111?page=1&per_page=25')
    const p = listingPosting(siteFor(url)!, document, url)
    expect(p).toMatchObject({ title: 'Data Analyst', company: 'Globex', jobId: '111', url: 'https://app.joinhandshake.com/jobs/111' })
    expect(p!.description).toContain('scheduling data')
    expect(p!.description).toContain('SQL and Python')
    expect(p!.description).not.toContain('Not part of the job')
  })

  it('knows the list page, and waits for the pane to load', () => {
    expect(siteFor(new URL('https://app.joinhandshake.com/job-search?page=1'))).toBeNull()
    expect(isListingHost(new URL('https://app.joinhandshake.com/job-search?page=1'))).toBe(true)
    expect(siteFor(new URL('https://app.joinhandshake.com/stu/jobs/123'))?.name).toBe('Handshake')
    document.body.innerHTML = '<h1>Jobs</h1><div data-hook="right-content"></div>'
    const url = new URL('https://app.joinhandshake.com/job-search/111')
    expect(listingPosting(siteFor(url)!, document, url)).toBeNull()
  })

  it('puts a pill on the scored card, next to its title', () => {
    document.body.innerHTML = pane('Globex', 'Data Analyst', DESC)
    const site = siteFor(new URL('https://app.joinhandshake.com/job-search/111'))!
    decorateCards(site, document, new Map([['111', score]]))
    const card = document.querySelector('[data-hook="job-result-card | 111"]')!
    expect(card.querySelectorAll('[data-zipply-pill="111"]')).toHaveLength(1)
    expect(card.querySelector('[data-zipply-pill="111"]')!.previousElementSibling!.textContent).toBe('Data Analyst')
    expect(document.querySelectorAll('[data-hook="job-result-card | 222"] [data-zipply-pill]')).toHaveLength(0)
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearStale, decorateCards, listingPosting, placePill, siteFor, type ListingScore } from '@/content/listings'

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

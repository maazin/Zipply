import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearStale, decorateCards, isLinkedInApplications, isListingHost, linkedinApplications, listingPosting, placePill, relativeDate, siteFor, titleFor, type ListingScore } from '@/content/listings'

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

  it("reads LinkedIn's newer layout: generated class names, no h1, the job by its headings", () => {
    document.title = '(3) Software Engineer | Discernis | LinkedIn'
    document.body.innerHTML = `<main><div class="d7iayq"><div class="d7iayy"><h2 class="d7ilje">About the job</h2></div>
      <div class="d7il5x"><p>Discernis builds analytics for the public sector.</p><p>What you'll do</p><ul><li>Build services in Python and Go</li><li>Ship to AWS with Docker and Kubernetes</li></ul>
      <p>You have 2+ years with PostgreSQL and REST APIs.</p></div></div>
      <div><p>Job search faster with Premium</p><p>Restart Premium for $0 and see who's hiring for Tableau roles</p></div>
      <div><h2 class="d7ilje">About the company</h2><p>Discernis was founded in 2015 and uses Salesforce.</p></div></main>`
    const url = new URL('https://www.linkedin.com/jobs/search-results/?currentJobId=4484491111&keywords=software%20engineer')
    const p = listingPosting(siteFor(url)!, document, url)
    expect(p).toMatchObject({ title: 'Software Engineer', company: 'Discernis', jobId: '4484491111' })
    expect(p!.description).toContain('Build services in Python and Go')
    expect(p!.description).not.toContain('Salesforce')
    expect(p!.description).not.toContain('Premium')
    document.title = ''
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

describe('clipped and thin postings', () => {
  it('opens a clipped Handshake description before reading it, once per job', () => {
    document.body.innerHTML = `<div data-hook="right-content"><a href="/e/1">Globex</a><a href="/jobs/111"><h1>Data Analyst</h1></a>
      <div><h3>Job description</h3><div id="d"><p>Globex helps hospitals plan staffing, and we are growing fast every year.</p><span>...</span><button aria-label="Show more (Data Analyst)">More</button></div></div>
      <div><h3>About the employer</h3></div></div>`
    let clicks = 0
    document.querySelector('button')!.addEventListener('click', () => {
      clicks++
      document.querySelector('#d')!.innerHTML = '<p>Globex helps hospitals plan staffing.</p><p>Build Tableau dashboards on SQL and Python, and keep Excel models tidy.</p><button aria-label="Show less (Data Analyst)">Less</button>'
    })
    const url = new URL('https://app.joinhandshake.com/job-search/111')
    const site = siteFor(url)!
    expect(listingPosting(site, document, url)).toBeNull() // clipped: opened, read next time
    const p = listingPosting(site, document, url)!
    expect(clicks).toBe(1)
    expect(p.description).toContain('Tableau dashboards')
    expect(p.description).not.toMatch(/\bLess\b|\.\.\./)
    // You collapse it again: it stays collapsed.
    document.querySelector('#d')!.innerHTML = '<p>Globex helps hospitals plan staffing, and we are growing fast every year.</p><span>...</span><button aria-label="Show more (Data Analyst)">More</button>'
    listingPosting(site, document, url)
    expect(clicks).toBe(1)
  })

  it('labels a posting too thin to score instead of showing a number', async () => {
    const { pillLabel } = await import('@/content/listings')
    expect(pillLabel({ score: null, verdict: 'Maybe', reason: 'x', applied: false, thin: true })).toBe('Not enough detail')
  })
})


describe("LinkedIn's newer layout (/jobs/search-results/)", () => {
  // As LinkedIn renders it in November 2026: generated class names, cards keyed by
  // componentkey (twice, outer and inner), each line a <p>, the title read aloud
  // from a second span, and the open job's title a plain link.
  const card = (id: string, title: string, company: string, extra = '') => `
    <div data-display-contents="true"><div role="button" tabindex="0" componentkey="job-card-component-ref-${id}">
      <div componentkey="job-card-component-ref-${id}"><div><div><p class="x1"><span class="a b">${title}</span><span aria-hidden="true">${title}</span></p></div>
      <div><p class="x2">${company}</p><p class="x3">Austin, TX (On-site)</p></div>${extra}</div></div></div></div>`
  const DESC = 'Build services in Python and Go, ship to AWS with Docker, and keep PostgreSQL fast for our analytics product.'
  const page = (open: string, status = '') => `<main>
    <div data-testid="lazy-column">${card('4485612866', 'Junior Developer', 'BodySpec')}<hr role="presentation">${card('4492202347', 'Database Administrator', 'Webull Financial', '<div><p>Applied</p></div>')}</div>
    <div><div><p>${open === '4485612866' ? 'BodySpec' : 'Webull Financial'}</p></div>
      <div><p class="t"><a href="https://www.linkedin.com/jobs/view/${open}/">${open === '4485612866' ? 'Junior Developer' : 'Database Administrator'}</a></p></div>
      ${status}
      <div><h2>About the job</h2><div><p>${DESC}</p></div></div>
      <div><h2>About the company</h2><p>Not part of the job.</p></div></div></main>`
  const STATUS = '<div><div><h2>Application status</h2></div><div><p>Application submitted</p><p>7 minutes ago</p><a href="#">View resume</a></div></div>'
  const url = (id: string) => new URL(`https://www.linkedin.com/jobs/search-results/?currentJobId=${id}&keywords=software%20engineer`)

  it('reads the open job and finds its title link, not the card', () => {
    document.title = 'Junior Developer | BodySpec | LinkedIn'
    document.body.innerHTML = page('4485612866')
    const site = siteFor(url('4485612866'))!
    expect(listingPosting(site, document, url('4485612866'))).toMatchObject({ title: 'Junior Developer', company: 'BodySpec', jobId: '4485612866' })
    const title = titleFor(site, document, '4485612866')!
    expect(title.tagName).toBe('A')
    expect(title.closest('[componentkey]')).toBeNull()
    placePill(title, '4485612866', score)
    expect(document.querySelectorAll('p.t [data-zipply-pill="4485612866"]')).toHaveLength(1)
    // The title still reads cleanly with the pill beside it.
    expect(listingPosting(site, document, url('4485612866'))!.title).toBe('Junior Developer')
    document.title = ''
  })

  it('puts one pill on each scored card, on the title line', () => {
    document.body.innerHTML = page('4485612866')
    const site = siteFor(url('4485612866'))!
    const scores = new Map([['4485612866', score]])
    decorateCards(site, document, scores)
    decorateCards(site, document, scores)
    const pills = document.querySelectorAll('[data-testid="lazy-column"] [data-zipply-pill]')
    expect(pills).toHaveLength(1)
    expect(pills[0].getAttribute('data-zipply-pill')).toBe('4485612866')
    expect(pills[0].parentElement!.classList.contains('x1')).toBe(true)
    expect(pills[0].shadowRoot!.textContent).toBe('78 · Apply')
  })

  it('finds the title as text on /jobs/view/ pages, where it is not a link', () => {
    document.title = 'Database Administrator | Webull Financial | LinkedIn'
    document.body.innerHTML = `<main><div><p>Webull Financial</p></div><div><p class="t">Database Administrator </p></div>
      <div><h2>About the job</h2><div><p>${DESC}</p></div></div></main>`
    const u = new URL('https://www.linkedin.com/jobs/view/4492202347/')
    const site = siteFor(u)!
    expect(listingPosting(site, document, u)).toMatchObject({ title: 'Database Administrator', company: 'Webull Financial', jobId: '4492202347' })
    expect(titleFor(site, document, '4492202347')?.className).toBe('t')
    document.title = ''
  })

  it("dates an application from the job's Application status", () => {
    document.body.innerHTML = page('4492202347', STATUS)
    const site = siteFor(url('4492202347'))!
    expect(site.appliedOn!(document, '4492202347')).toBe(relativeDate('7 minutes ago'))
    expect(site.appliedOn!(document, '4492202347')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // The pane still shows another job (the next one loading): not this one's.
    expect(site.appliedOn!(document, '4485612866')).toBe('')
    // No status: not applied.
    document.body.innerHTML = page('4485612866')
    expect(site.appliedOn!(document, '4485612866')).toBe('')
  })

  it('turns "Applied 2d ago" into a day, and leaves months and years undated', () => {
    const now = new Date('2026-11-19T15:00:00')
    expect(relativeDate('Applied 7m ago', now)).toBe('2026-11-19')
    expect(relativeDate('Applied 3h ago', now)).toBe('2026-11-19')
    expect(relativeDate('Applied 16h ago', now)).toBe('2026-11-18')
    expect(relativeDate('2 days ago', now)).toBe('2026-11-17')
    expect(relativeDate('Applied 1w ago', now)).toBe('2026-11-12')
    expect(relativeDate('an hour ago', now)).toBe('2026-11-19')
    expect(relativeDate('Applied 1mo ago', now)).toBe('')
    expect(relativeDate('Applied 2yr ago', now)).toBe('')
    expect(relativeDate('Application submitted', now)).toBe('')
  })

  it("reads the Job tracker's Applied tab", () => {
    expect(isLinkedInApplications(new URL('https://www.linkedin.com/jobs-tracker/?stage=applied'))).toBe(true)
    expect(isLinkedInApplications(new URL('https://www.linkedin.com/jobs-tracker/'))).toBe(false)
    expect(isLinkedInApplications(new URL('https://www.linkedin.com/my-items/saved-jobs/?cardType=APPLIED'))).toBe(true)
    const row = (id: string, title: string, verified: boolean, coLoc: string, applied: string) => `
      <div class="r"><div><input type="checkbox" aria-label="Select"></div>
        <a href="https://www.linkedin.com/jobs/view/${id}/?trk=x"><div><span class="sr">${title}${verified ? ' (Verified job)' : ''}</span><span aria-hidden="true">${title} </span></div>
        <div><p>${coLoc}</p><p>${applied}</p><p>(Posted 10h ago)</p></div></a>
        <div><p>Did you hear back?</p><button><span>Yes</span></button><button><span>No</span></button></div></div>`
    document.body.innerHTML = `<main><p>Job tracker</p><div><button>Saved · 4</button><button>Applied · 175</button></div><div>
      ${row('4492202347', 'Database Administrator', true, 'Webull Financial · St. Petersburg, FL (On-site)', 'Applied 7m ago')}
      ${row('4489686632', 'FSR Engineer', false, 'CGS Federal (Contact Government Services) · Tampa, FL (On-site)', 'Applied 2d ago')}
      ${row('4400000000', 'Old Job', false, 'Initech · Remote', 'Applied 3mo ago')}
    </div></main>`
    const jobs = linkedinApplications(document, new Date('2026-11-19T15:00:00'))
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toMatchObject({ date: '2026-11-19', posting: { title: 'Database Administrator', company: 'Webull Financial', location: 'St. Petersburg, FL (On-site)', jobId: '4492202347', url: 'https://www.linkedin.com/jobs/view/4492202347/' } })
    expect(jobs[1]).toMatchObject({ date: '2026-11-17', posting: { title: 'FSR Engineer', company: 'CGS Federal (Contact Government Services)', jobId: '4489686632' } })
  })
})

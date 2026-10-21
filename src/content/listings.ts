// Match scores on job listings (LinkedIn, Indeed). When you open a job in the
// results list, its full description is scored against your resumes and a
// small pill appears next to the title, and on that job's card in the list.
// Nothing is fetched in the background: only jobs you open are scored.
import type { Posting, Verdict } from '@/shared/types'
import { htmlToText, mergePosting } from './posting'

export interface ListingSite {
  name: 'LinkedIn' | 'Indeed'
  matches(url: URL): boolean
  jobId(url: URL, doc: Document): string
  title: string
  company: string
  location: string
  description: string
  /** Job cards in the results list, and how to read a card's job ID. */
  cards: string
  cardId(card: Element): string
  cardTitle(card: Element): Element | null
}

export const SITES: ListingSite[] = [
  {
    name: 'LinkedIn',
    matches: (u) => /(^|\.)linkedin\.com$/.test(u.hostname) && u.pathname.startsWith('/jobs'),
    jobId: (u, doc) =>
      u.searchParams.get('currentJobId') ||
      u.pathname.match(/\/jobs\/view\/(\d+)/)?.[1] ||
      doc.querySelector('[data-job-id].jobs-search-results-list__list-item--active, .jobs-search-results-list__list-item--active [data-job-id]')?.getAttribute('data-job-id') ||
      '',
    title: '.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, .top-card-layout__title, .jobs-details h1, h1.t-24',
    company: '.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name, .topcard__org-name-link, .top-card-layout__second-subline a',
    location: '.job-details-jobs-unified-top-card__primary-description-container .tvm__text, .job-details-jobs-unified-top-card__bullet, .topcard__flavor--bullet',
    description: '#job-details, .jobs-description__content, .jobs-description-content__text, .show-more-less-html__markup, .description__text',
    cards: '[data-occludable-job-id], li [data-job-id], .job-card-container[data-job-id]',
    cardId: (c) => c.getAttribute('data-occludable-job-id') || c.getAttribute('data-job-id') || c.querySelector('[data-job-id]')?.getAttribute('data-job-id') || '',
    cardTitle: (c) => c.querySelector('.job-card-list__title, .job-card-list__title--link, .job-card-container__link, a[href*="/jobs/view/"]'),
  },
  {
    name: 'Indeed',
    matches: (u) => /(^|\.)indeed\.com$/.test(u.hostname),
    jobId: (u, doc) => u.searchParams.get('vjk') || u.searchParams.get('jk') || doc.querySelector('[data-jk].selected, .jobsearch-ResultsList .vjs-highlight [data-jk]')?.getAttribute('data-jk') || '',
    title: '[data-testid="jobsearch-JobInfoHeader-title"], .jobsearch-JobInfoHeader-title, #viewJobSSRRoot h1',
    company: '[data-testid="inlineHeader-companyName"], [data-company-name="true"], .jobsearch-CompanyInfoContainer a',
    location: '[data-testid="inlineHeader-companyLocation"], [data-testid="job-location"], .jobsearch-JobInfoHeader-subtitle > div:last-child',
    description: '#jobDescriptionText',
    cards: 'a[data-jk], [data-jk]:not(a)',
    cardId: (c) => c.getAttribute('data-jk') || '',
    cardTitle: (c) => (c.matches('a') ? c : c.querySelector('a[data-jk], h2 a')),
  },
]

export function siteFor(url: URL): ListingSite | null {
  return SITES.find((s) => s.matches(url)) ?? null
}

const text = (doc: Document, sel: string) => doc.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

/** The job open in the detail pane, if its description has loaded. */
export function listingPosting(site: ListingSite, doc: Document, url: URL): Posting | null {
  const id = site.jobId(url, doc)
  const descEl = doc.querySelector<HTMLElement>(site.description)
  const description = descEl ? htmlToText(descEl.innerHTML) : ''
  // The title without our own pill's text.
  const titleEl = doc.querySelector(site.title)
  const title = titleEl ? Array.from(titleEl.childNodes).filter((n) => !(n instanceof Element && n.hasAttribute('data-zipply-pill'))).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim() : ''
  if (!id || !title || description.length < 80) return null
  const jobUrl = site.name === 'LinkedIn' ? `https://www.linkedin.com/jobs/view/${id}/` : `https://${url.hostname}/viewjob?jk=${id}`
  return mergePosting(jobUrl, { title, company: text(doc, site.company), location: text(doc, site.location), description, jobId: id })
}

export interface ListingScore {
  score: number | null
  verdict: Verdict
  reason: string
  applied: boolean
}

const COLORS: Record<Verdict, string> = { Apply: '#15803d', Maybe: '#b45309', Skip: '#c42121' }

/** A small pill in its own shadow root, so the site's styles can't touch it (and it can't touch theirs). */
export function pill(doc: Document, jobId: string, s: ListingScore): HTMLElement {
  const host = doc.createElement('span')
  host.setAttribute('data-zipply-pill', jobId)
  host.style.marginLeft = '8px'
  host.style.verticalAlign = 'middle'
  const root = host.attachShadow({ mode: 'open' })
  const color = s.applied ? '#6b6b76' : COLORS[s.verdict]
  const label = s.applied ? 'Applied' : s.score == null ? s.verdict : `${s.score} · ${s.verdict}`
  root.innerHTML = `<span title="Zipply: ${s.reason.replace(/"/g, '&quot;')}" style="display:inline-flex;align-items:center;gap:4px;font:600 11px/1.6 system-ui,-apple-system,sans-serif;color:${color};border:1px solid ${color}55;border-radius:999px;padding:0 7px;background:transparent;white-space:nowrap">${label}</span>`
  return host
}

const HEADING = /^H[1-6]$/

/** The pill already next to `anchor` (inside a heading, or right after a link). */
export function pillFor(anchor: Element, jobId: string): Element | null {
  const sel = `:scope > [data-zipply-pill="${jobId}"]`
  return (HEADING.test(anchor.tagName) ? anchor.querySelector(sel) : null) ?? anchor.parentElement?.querySelector(sel) ?? null
}

/**
 * Put (or refresh) the pill by `anchor`: inside a heading so it sits on the
 * title's line, otherwise right after it (never inside a link).
 */
export function placePill(anchor: Element | null, jobId: string, s: ListingScore) {
  if (!anchor) return
  pillFor(anchor, jobId)?.remove()
  const el = pill(anchor.ownerDocument, jobId, s)
  if (HEADING.test(anchor.tagName)) anchor.append(el)
  else anchor.insertAdjacentElement('afterend', el)
}

/** Pills on every card in the list that has been scored. */
export function decorateCards(site: ListingSite, doc: Document, scores: Map<string, ListingScore>) {
  for (const card of Array.from(doc.querySelectorAll(site.cards))) {
    const id = site.cardId(card)
    const s = id ? scores.get(id) : undefined
    if (!s) continue
    const title = site.cardTitle(card)
    if (title && !pillFor(title, id)) placePill(title, id, s)
  }
}

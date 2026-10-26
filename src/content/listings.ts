// Match scores on job listings (LinkedIn, Indeed, Handshake). When you open a job in the
// results list, its full description is scored against your resumes and a
// small pill appears next to the title, and on that job's card in the list.
// Nothing is fetched in the background: only jobs you open are scored.
import type { Posting, Verdict } from '@/shared/types'
import { htmlToText, mergePosting } from './posting'

export interface ListingSite {
  name: 'LinkedIn' | 'Indeed' | 'Handshake'
  matches(url: URL): boolean
  jobId(url: URL, doc: Document): string
  /** The job's own address, for the sheet and the already-applied check. */
  jobUrl(id: string, url: URL): string
  title: string
  company: string
  location: string
  description: string
  /** For pages a selector can't read (Handshake's generated class names). */
  read?(doc: Document): { company?: string; location?: string; description?: string }
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
    jobUrl: (id) => `https://www.linkedin.com/jobs/view/${id}/`,
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
    jobUrl: (id, u) => `https://${u.hostname}/viewjob?jk=${id}`,
    title: '[data-testid="jobsearch-JobInfoHeader-title"], .jobsearch-JobInfoHeader-title, #viewJobSSRRoot h1',
    company: '[data-testid="inlineHeader-companyName"], [data-company-name="true"], .jobsearch-CompanyInfoContainer a',
    location: '[data-testid="inlineHeader-companyLocation"], [data-testid="job-location"], .jobsearch-JobInfoHeader-subtitle > div:last-child',
    description: '#jobDescriptionText',
    cards: 'a[data-jk], [data-jk]:not(a)',
    cardId: (c) => c.getAttribute('data-jk') || '',
    cardTitle: (c) => (c.matches('a') ? c : c.querySelector('a[data-jk], h2 a')),
  },
  {
    // A single-page app: picking another job changes the address and the
    // right-hand pane, never the page. Class names are generated, so the pane
    // is read by its data-hook, its h1 and its section headings.
    name: 'Handshake',
    matches: (u) => /(^|\.)joinhandshake\.com$/.test(u.hostname) && /^\/(job-search|jobs|stu\/jobs)\/\d+/.test(u.pathname),
    jobId: (u) => u.pathname.match(/\/(?:job-search|jobs|stu\/jobs)\/(\d+)/)?.[1] ?? '',
    jobUrl: (id) => `https://app.joinhandshake.com/jobs/${id}`,
    title: '[data-hook="right-content"] h1',
    company: '[data-hook="right-content"] a[href^="/e/"]',
    location: '',
    description: '',
    read: (doc) => {
      const pane = doc.querySelector('[data-hook="right-content"]')
      if (!pane) return {}
      const company = Array.from(pane.querySelectorAll('a[href^="/e/"]')).map((a) => a.textContent?.trim() ?? '').find(Boolean) ?? ''
      return { company, description: sectionText(pane, /^Job description$/i, /^(About the employer|Similar jobs)$/i) }
    },
    // data-hook="job-result-card | 11626853"; the company is a span, the title the first text div.
    cards: '[data-hook^="job-result-card"]',
    cardId: (c) => c.getAttribute('data-hook')?.match(/\d+/)?.[0] ?? '',
    cardTitle: (c) => Array.from(c.querySelectorAll('div')).find((d) => d.children.length === 0 && Boolean(d.textContent?.trim())) ?? null,
  },
]

/** Text from the heading matching `start` up to the heading matching `stop`. */
function sectionText(root: Element, start: RegExp, stop: RegExp): string {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const parts: string[] = []
  let on = false
  while (walker.nextNode()) {
    const node = walker.currentNode
    const heading = node.parentElement?.closest('h2, h3, h4')
    const label = heading?.textContent?.trim() ?? ''
    if (heading && start.test(label)) {
      on = true
      continue
    }
    if (heading && on && stop.test(label)) break
    if (on && node.textContent?.trim()) parts.push(node.textContent.trim())
  }
  return parts.join('\n')
}

/** Sites with listings, whatever page you start on (the address changes as you browse). */
export function isListingHost(url: URL): boolean {
  return /(^|\.)(linkedin|indeed|joinhandshake)\.com$/.test(url.hostname)
}

export function siteFor(url: URL): ListingSite | null {
  return SITES.find((s) => s.matches(url)) ?? null
}

const text = (doc: Document, sel: string) => doc.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

/** The job open in the detail pane, if its description has loaded. */
export function listingPosting(site: ListingSite, doc: Document, url: URL): Posting | null {
  const id = site.jobId(url, doc)
  const extra = site.read?.(doc) ?? {}
  const descEl = site.description ? doc.querySelector<HTMLElement>(site.description) : null
  const description = extra.description ?? (descEl ? htmlToText(descEl.innerHTML) : '')
  // The title without our own pill's text.
  const titleEl = doc.querySelector(site.title)
  const title = titleEl ? Array.from(titleEl.childNodes).filter((n) => !(n instanceof Element && n.hasAttribute('data-zipply-pill'))).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim() : ''
  if (!id || !title || description.length < 80) return null
  return mergePosting(site.jobUrl(id, url), {
    title,
    company: extra.company ?? text(doc, site.company),
    location: extra.location ?? (site.location ? text(doc, site.location) : ''),
    description,
    jobId: id,
  })
}

export interface ListingScore {
  score: number | null
  verdict: Verdict
  reason: string
  applied: boolean
  /** Your resumes for this job, best first. */
  resumes?: { label: string; score: number }[]
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
  const label = pillLabel(s)
  root.innerHTML = `<span title="${esc(pillTitle(s))}" style="display:inline-flex;align-items:center;gap:4px;font:600 11px/1.6 system-ui,-apple-system,sans-serif;color:${color};border:1px solid ${color}55;border-radius:999px;padding:0 7px;background:transparent;white-space:nowrap">${label}</span>`
  return host
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
const short = (t: string) => (t.length > 16 ? `${t.slice(0, 15)}…` : t)

/** "78 · Apply", plus the best resume's name when you have more than one. */
export function pillLabel(s: ListingScore): string {
  if (s.applied) return 'Applied'
  const base = s.score == null ? s.verdict : `${s.score} · ${s.verdict}`
  const best = s.resumes?.[0]
  return best && s.resumes!.length > 1 ? `${base} · ${esc(short(best.label))}` : base
}

/** The hover text: the verdict's reason, then every resume's score. */
export function pillTitle(s: ListingScore): string {
  const lines = [`Zipply: ${s.reason}`]
  if (s.resumes && s.resumes.length > 1) {
    lines.push(`Best resume: ${s.resumes[0].label} (${s.resumes[0].score})`)
    lines.push(`Others: ${s.resumes.slice(1).map((r) => `${r.label} ${r.score}`).join(', ')}`)
  }
  return lines.join('\n')
}

const HEADING = /^H[1-6]$/

/** The heading the pill goes inside: the anchor itself, or one it wraps (LinkedIn's title is a div around an h1). */
function headingOf(anchor: Element): Element | null {
  return HEADING.test(anchor.tagName) ? anchor : anchor.querySelector('h1, h2, h3, h4, h5, h6')
}

/** Pills already by `anchor`, for any job. */
function pillsBy(anchor: Element): Element[] {
  const box = headingOf(anchor) ?? anchor.parentElement
  return box ? Array.from(box.querySelectorAll(':scope > [data-zipply-pill]')) : []
}

/** The pill already next to `anchor` (inside its heading, or right after a link). */
export function pillFor(anchor: Element, jobId: string): Element | null {
  return pillsBy(anchor).find((p) => p.getAttribute('data-zipply-pill') === jobId) ?? null
}

/**
 * Put (or refresh) the pill by `anchor`: inside a heading so it sits on the
 * title's line, otherwise right after it (never inside a link). Pills for other
 * jobs there are removed, since sites reuse the same title element and cards.
 */
export function placePill(anchor: Element | null, jobId: string, s: ListingScore) {
  if (!anchor) return
  for (const p of pillsBy(anchor)) p.remove()
  const el = pill(anchor.ownerDocument, jobId, s)
  const heading = headingOf(anchor)
  if (heading) heading.append(el)
  else anchor.insertAdjacentElement('afterend', el)
}

/** Drop pills by `anchor` that belong to a different job. */
export function clearStale(anchor: Element | null, jobId: string) {
  if (!anchor) return
  for (const p of pillsBy(anchor)) if (p.getAttribute('data-zipply-pill') !== jobId) p.remove()
}

/** Pills on every card in the list that has been scored. */
export function decorateCards(site: ListingSite, doc: Document, scores: Map<string, ListingScore>) {
  for (const card of Array.from(doc.querySelectorAll(site.cards))) {
    const id = site.cardId(card)
    const s = id ? scores.get(id) : undefined
    const title = site.cardTitle(card)
    clearStale(title, id)
    if (s && title && !pillFor(title, id)) placePill(title, id, s)
  }
}

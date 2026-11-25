// Match scores on job listings (LinkedIn, Indeed, Handshake). When you open a job in the
// results list, its full description is scored against your resumes and a
// small pill appears next to the title, and on that job's card in the list.
// Nothing is fetched in the background: only jobs you open are scored.
import type { Posting, Verdict } from '@/shared/types'
import { toISODate, todayISO } from '@/shared/text'
import { cleanText, mergePosting } from './posting'

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
  read?(doc: Document): { title?: string; company?: string; location?: string; description?: string }
  /** The date (ISO) the open job says you applied, if it says so. */
  appliedOn?(doc: Document, jobId: string): string
  /** The open job's title element, for pages `title` can't select (LinkedIn's newer layout). */
  titleEl?(doc: Document, jobId: string): Element | null
  /** Job cards in the results list, and how to read a card's job ID. */
  cards: string
  cardId(card: Element): string
  cardTitle(card: Element): Element | null
}

/** A job card in LinkedIn's newer results list. */
const LINKEDIN_CARD = '[componentkey^="job-card-component-ref-"]'
const LINKEDIN_DESCRIPTION = '#job-details, .jobs-description__content, .jobs-description-content__text, .show-more-less-html__markup, .description__text'
/** Headings after LinkedIn's description. */
const LINKEDIN_AFTER = /^(About the company|Meet the hiring team|People (also viewed|you can reach out to)|Similar jobs|More jobs.*|Benefits found in job post|Job search faster with Premium)$/i

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
    description: LINKEDIN_DESCRIPTION,
    // LinkedIn's newer layout (/jobs/search-results/) has generated class names and
    // no h1, so the selectors above find nothing. The page title still says
    // "Software Engineer | Discernis | LinkedIn", and the description sits under
    // "About the job" until "About the company".
    read: (doc) => {
      if (doc.querySelector(LINKEDIN_DESCRIPTION)) return {}
      const parts = linkedinTitleParts(doc)
      if (!parts) return {}
      // The smallest block around the heading that holds the text: Premium upsells sit
      // between "About the job" and "About the company", outside it.
      const head = Array.from((doc.querySelector('main') ?? doc.body).querySelectorAll('h2')).find((h) => /^About the job$/i.test(h.textContent?.trim() ?? ''))
      let box = head?.parentElement ?? null
      while (box && (box.textContent?.trim().length ?? 0) < (head!.textContent?.trim().length ?? 0) + 100) box = box.parentElement
      const description = box ? sectionText(box, /^About the job$/i, LINKEDIN_AFTER) : ''
      return { title: parts[0].trim(), company: parts[1].trim(), description }
    },
    // The newer layout: the title is a plain link to the job, or (on /jobs/view/) plain text.
    titleEl: (doc, jobId) => {
      if (!jobId) return null
      const root = doc.querySelector('main') ?? doc.body
      const link = Array.from(root.querySelectorAll(`a[href*="/jobs/view/${jobId}"]`)).find((a) => !a.closest(LINKEDIN_CARD) && a.textContent?.trim())
      if (link) return link
      const title = linkedinTitle(doc)
      return title ? (Array.from(root.querySelectorAll('h1, h2, p, span')).find((e) => !e.closest(LINKEDIN_CARD) && !e.querySelector('*:not([data-zipply-pill])') && ownText(e) === title) ?? null) : null
    },
    // An application on LinkedIn (Easy Apply has no confirmation page) shows
    // "Application status · Application submitted · 7 minutes ago" on the job.
    appliedOn: (doc, jobId) => {
      if (!linkedinShows(doc, jobId)) return ''
      const head = Array.from(doc.querySelectorAll('h2, h3')).find((h) => /^Application status$/i.test(h.textContent?.trim() ?? ''))
      let box = head?.parentElement ?? null
      while (box && !/Application submitted/i.test(box.textContent ?? '')) box = box.parentElement
      if (!box || box === doc.body) return ''
      return leafTexts(box).map((t) => relativeDate(t)).find(Boolean) ?? ''
    },
    // Older layout: data-occludable-job-id. Newer: componentkey="job-card-component-ref-4485612866",
    // twice (an outer and an inner element), so only the clickable one counts.
    cards: `[data-occludable-job-id], li [data-job-id], .job-card-container[data-job-id], [role="button"]${LINKEDIN_CARD}`,
    cardId: (c) =>
      c.getAttribute('data-occludable-job-id') ||
      c.getAttribute('data-job-id') ||
      c.getAttribute('componentkey')?.match(/^job-card-component-ref-(\d+)$/)?.[1] ||
      c.querySelector('[data-job-id]')?.getAttribute('data-job-id') ||
      '',
    cardTitle: (c) => c.querySelector('.job-card-list__title, .job-card-list__title--link, .job-card-container__link, a[href*="/jobs/view/"]') ?? (c.matches(LINKEDIN_CARD) ? c.querySelector('p') : null),
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
      // The description shows a few lines and "... More". Open it (as you would)
      // and read on the next look, so a clipped text is never scored.
      if (expandDescription(pane)) return { company, description: '' }
      return { company, description: sectionText(pane, /^Job description$/i, /^(About the employer|Similar jobs)$/i) }
    },
    // A job you applied to says "Applied on October 26, 2026" above its description.
    appliedOn: (doc, jobId) => {
      const pane = doc.querySelector('[data-hook="right-content"]')
      // The pane still showing the last job while the next one loads.
      const shown = pane?.querySelector('h1')?.closest('a')?.getAttribute('href')?.match(/\/jobs\/(\d+)/)?.[1]
      if (!pane || (shown && shown !== jobId)) return ''
      const h = Array.from(pane.querySelectorAll('h1, h2, h3, h4')).find((n) => /^Applied on /i.test(n.textContent?.trim() ?? ''))
      const d = h ? toISODate(h.textContent!.trim().replace(/^Applied on /i, '')) : ''
      return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : ''
    },
    // data-hook="job-result-card | 11626853"; the company is a span, the title the first text div.
    cards: '[data-hook^="job-result-card"]',
    cardId: (c) => c.getAttribute('data-hook')?.match(/\d+/)?.[0] ?? '',
    cardTitle: (c) => Array.from(c.querySelectorAll('div')).find((d) => d.children.length === 0 && Boolean(d.textContent?.trim())) ?? null,
  },
]

/** "Software Engineer | Discernis | LinkedIn" (the page title of an open job), in parts. */
function linkedinTitleParts(doc: Document): string[] | null {
  const parts = doc.title.replace(/^\(\d+\)\s*/, '').split(' | ')
  return parts.length >= 3 && parts[parts.length - 1] === 'LinkedIn' ? parts : null
}

const linkedinTitle = (doc: Document) => linkedinTitleParts(doc)?.[0].trim() ?? ''

/** The element's text without our pill's. */
function ownText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => !(n instanceof Element && n.hasAttribute('data-zipply-pill')))
    .map((n) => n.textContent)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The page shows this job (not the last one, while the next loads). */
function linkedinShows(doc: Document, jobId: string): boolean {
  if (!jobId) return false
  if (doc.location?.pathname.includes(`/jobs/view/${jobId}`)) return true
  return Array.from(doc.querySelectorAll(`a[href*="/jobs/view/${jobId}"]`)).some((a) => !a.closest(LINKEDIN_CARD))
}

/** The text of each element with no child elements, in order. */
function leafTexts(root: Element): string[] {
  return [root, ...Array.from(root.querySelectorAll('*'))]
    .filter((e) => !e.children.length && !e.closest('[data-zipply-pill]'))
    .map((e) => e.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter(Boolean)
}

const UNITS: [RegExp, number][] = [
  [/^(mo|mos|months?)$/, -1],
  [/^(y|yr|yrs|years?)$/, -1],
  [/^(s|secs?|seconds?)$/, 0],
  [/^(m|mins?|minutes?)$/, 0],
  [/^(h|hrs?|hours?)$/, 0],
  [/^(d|days?)$/, 1],
  [/^(w|wks?|weeks?)$/, 7],
]

/**
 * The day (ISO) for LinkedIn's "Applied 7m ago", "3 days ago", "2w ago". Months
 * and years are too vague to date an application, so they give ''.
 */
export function relativeDate(text: string, now = new Date()): string {
  const t = text.trim().replace(/^Applied\s+/i, '')
  if (/^(just now|now|today)$/i.test(t)) return todayISO(now)
  if (/^yesterday$/i.test(t)) return todayISO(new Date(now.getTime() - 86_400_000))
  const m = t.match(/^(\d+|an?|one)\s*([a-z]+)\s+ago$/i)
  if (!m) return ''
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1
  const days = UNITS.find(([re]) => re.test(m[2].toLowerCase()))?.[1]
  if (days == null || days < 0) return ''
  if (days === 0) {
    const ms = /^h/i.test(m[2]) ? n * 3_600_000 : /^s/i.test(m[2]) ? n * 1000 : n * 60_000
    return todayISO(new Date(now.getTime() - ms))
  }
  return todayISO(new Date(now.getTime() - n * days * 86_400_000))
}

/** LinkedIn's Job tracker, Applied tab: your applications, each "Applied 2d ago". */
export function isLinkedInApplications(url: URL): boolean {
  if (!/(^|\.)linkedin\.com$/.test(url.hostname)) return false
  if (url.pathname.startsWith('/jobs-tracker')) return url.searchParams.get('stage')?.toLowerCase() === 'applied'
  return url.pathname.startsWith('/my-items/saved-jobs') && url.searchParams.get('cardType')?.toUpperCase() === 'APPLIED'
}

/**
 * One row per application: the title (read aloud as "… (Verified job)"),
 * "Company · Location" and "Applied 7m ago". Rows dated in months or years are skipped.
 */
export function linkedinApplications(doc: Document, now = new Date()): AppliedJob[] {
  const out: AppliedJob[] = []
  const seen = new Set<string>()
  const root = doc.querySelector('main') ?? doc.body
  for (const a of Array.from(root.querySelectorAll('a[href*="/jobs/view/"]'))) {
    const id = a.getAttribute('href')?.match(/\/jobs\/view\/(\d+)/)?.[1]
    if (!id || seen.has(id)) continue
    // The smallest box around the link that says when you applied, and holds no other job.
    const otherJob = (el: Element) => Array.from(el.querySelectorAll('a[href*="/jobs/view/"]')).some((x) => !x.getAttribute('href')?.includes(`/jobs/view/${id}`))
    let row: Element | null = a
    while (row && row !== root && !otherJob(row) && !leafTexts(row).some((t) => /^Applied\b.*\bago$/i.test(t))) row = row.parentElement
    if (!row || row === root || otherJob(row)) continue
    seen.add(id)
    const texts = leafTexts(row)
    const date = texts.map((t) => (/^Applied\b/i.test(t) ? relativeDate(t, now) : '')).find(Boolean)
    const at = texts.findIndex((t) => t.includes(' · '))
    if (!date || at < 1) continue
    const [company, ...rest] = texts[at].split(' · ')
    const title = texts[0].replace(/\s*\(Verified job\)\s*$/i, '').trim()
    if (!company.trim() || !title) continue
    out.push({ posting: mergePosting(`https://www.linkedin.com/jobs/view/${id}/`, { title, company: company.trim(), location: rest.join(' · ').trim(), jobId: id }), date })
  }
  return out
}

/** The open job's title element, where its pill goes. */
export function titleFor(site: ListingSite, doc: Document, jobId: string): Element | null {
  return doc.querySelector(site.title) ?? site.titleEl?.(doc, jobId) ?? null
}

export interface AppliedJob {
  posting: Posting
  /** ISO date */
  date: string
}

/** Handshake's list of your applications ("My jobs", /apps): one table row per application. */
export function isHandshakeApplications(url: URL): boolean {
  return /(^|\.)joinhandshake\.com$/.test(url.hostname) && /^\/(apps|applications|stu\/applications)\/?$/.test(url.pathname)
}

export function handshakeApplications(doc: Document): AppliedJob[] {
  const out: AppliedJob[] = []
  for (const row of Array.from(doc.querySelectorAll('tr'))) {
    const link = row.querySelector<HTMLAnchorElement>('a[href*="/jobs/"]')
    const id = link?.getAttribute('href')?.match(/\/jobs\/(\d+)/)?.[1]
    if (!id) continue
    const cell = (h: string) => row.querySelector(`td[headers="${h}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    // The link's label says it all too: "Employer, Avery. Title, Analyst. Location, …. Applied, 10/26/2026. Status, Applied"
    const label = link!.getAttribute('aria-label') ?? ''
    const part = (name: string) => label.match(new RegExp(`(?:^|\\. )${name}, (.+?)(?=\\. [A-Z][a-z]+, |$)`))?.[1]?.trim() ?? ''
    const company = row.querySelector('td[headers="employerName"] p')?.textContent?.trim() || part('Employer')
    const title = cell('title') || part('Title')
    const date = toISODate(cell('applicationDate') || part('Applied'))
    if (!company || !title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    out.push({ posting: mergePosting(`https://app.joinhandshake.com/jobs/${id}`, { title, company, location: cell('location') || part('Location'), jobId: id }), date })
  }
  return out
}

/** Jobs whose description was opened, so collapsing it again yourself sticks. */
const expanded = new Set<string>()

/** Click the description's own "Show more" once per job. True if it was clipped and just opened. */
function expandDescription(pane: Element): boolean {
  const job = pane.querySelector('h1')?.closest('a')?.getAttribute('href')?.match(/\d+/)?.[0] ?? ''
  if (!job || expanded.has(job)) return false
  const heading = Array.from(pane.querySelectorAll('h2, h3, h4')).find((h) => /^Job description$/i.test(h.textContent?.trim() ?? ''))
  if (!heading) return false
  const more = Array.from(pane.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => /^show more/i.test(b.getAttribute('aria-label') ?? '') && Boolean(heading.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING),
  )
  if (!more) return false
  expanded.add(job)
  more.click()
  return true
}

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
    // Skip the clipping marks and buttons ("...", "More", "Less").
    if (on && node.textContent?.trim() && !node.parentElement?.closest('button') && !/^(\.\.\.|…)$/.test(node.textContent.trim())) parts.push(node.textContent.trim())
  }
  return parts.join('\n')
}

/** Sites with listings, whatever page you start on (the address changes as you browse). */
export function isListingHost(url: URL): boolean {
  return /(^|\.)(linkedin|indeed|joinhandshake)\.com$|(^|\.)amazon\.jobs$/.test(url.hostname)
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
  const description = extra.description ?? (descEl ? cleanText(descEl) : '')
  // The title without our own pill's text.
  const titleEl = doc.querySelector(site.title)
  const title =
    (titleEl ? Array.from(titleEl.childNodes).filter((n) => !(n instanceof Element && n.hasAttribute('data-zipply-pill'))).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim() : '') ||
    extra.title ||
    ''
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
  /** Too little of the posting to score. */
  thin?: boolean
  /** The posting's top keywords your best resume has. */
  matched?: string[]
}

const COLORS: Record<Verdict, string> = { Apply: '#15803d', Maybe: '#b45309', Skip: '#c42121' }

/** A small pill in its own shadow root, so the site's styles can't touch it (and it can't touch theirs). */
export function pill(doc: Document, jobId: string, s: ListingScore): HTMLElement {
  const host = doc.createElement('span')
  host.setAttribute('data-zipply-pill', jobId)
  host.style.marginLeft = '8px'
  host.style.verticalAlign = 'middle'
  const root = host.attachShadow({ mode: 'open' })
  const color = s.applied || s.thin ? '#6b6b76' : COLORS[s.verdict]
  const label = pillLabel(s)
  root.innerHTML = `<span title="${esc(pillTitle(s))}" style="display:inline-flex;align-items:center;gap:4px;font:600 11px/1.6 system-ui,-apple-system,sans-serif;color:${color};border:1px solid ${color}55;border-radius:999px;padding:0 7px;background:transparent;white-space:nowrap">${label}</span>`
  return host
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
const short = (t: string) => (t.length > 16 ? `${t.slice(0, 15)}…` : t)

/** "78 · Apply", the best resume's name when you have more than one, and the top two keywords you match. */
export function pillLabel(s: ListingScore): string {
  if (s.applied) return 'Applied'
  if (s.thin) return 'Not enough detail'
  const base = s.score == null ? s.verdict : `${s.score} · ${s.verdict}`
  const best = s.resumes?.[0]
  const withResume = best && s.resumes!.length > 1 ? `${base} · ${esc(short(best.label))}` : base
  return s.matched?.length ? `${withResume} · ✓ ${esc(s.matched.slice(0, 2).join(', '))}` : withResume
}

/** The hover text: the verdict's reason, then every resume's score. */
export function pillTitle(s: ListingScore): string {
  const lines = [`Zipply: ${s.reason}`]
  if (s.matched?.length) lines.push(`Matched: ${s.matched.join(', ')}`)
  if (s.resumes && s.resumes.length > 1) {
    lines.push(`Best resume: ${s.resumes[0].label} (${s.resumes[0].score})`)
    lines.push(`Others: ${s.resumes.slice(1).map((r) => `${r.label} ${r.score}`).join(', ')}`)
  }
  return lines.join('\n')
}

const HEADING = /^H[1-6]$/

/**
 * The line the pill goes inside: the anchor itself when it's a heading or a
 * paragraph (LinkedIn's newer cards), or a heading it wraps (LinkedIn's title
 * is a div around an h1).
 */
function headingOf(anchor: Element): Element | null {
  return HEADING.test(anchor.tagName) || anchor.tagName === 'P' ? anchor : anchor.querySelector('h1, h2, h3, h4, h5, h6')
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

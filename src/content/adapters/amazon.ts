// Amazon's own job site, amazon.jobs: postings on /{lang}/jobs/{id}/{slug},
// applications under /applicant/ (sign-in, then Amazon's own steps). The posting
// page has no structured data: the job is read from its sections (Description,
// Basic and Preferred Qualifications). Your Applications page lists each one
// with "Applied: Nov 24, 2026", which logs those the sheet doesn't have.
import type { Posting } from '@/shared/types'
import type { Adapter } from './types'
import { genericConfirmation } from './types'
import { cleanText, fetchPosting, mergePosting } from '../posting'
import { toISODate } from '@/shared/text'
import { workModeOf } from '@/core/score/postingSignals'

const HOST = /(^|\.)amazon\.jobs$/

export const isAmazonJobs = (url: URL) => HOST.test(url.hostname)

/** The job ID in a posting's or an application's address. */
export function amazonJobId(url: URL): string {
  return url.pathname.match(/\/jobs\/(\d{5,})(?:\/|$)/)?.[1] ?? ''
}

/** "Job ID: 10386857 | Amazon Web Services Australia Pty Ltd" names the hiring entity: Amazon's own count as Amazon. */
function companyOf(meta: string): string {
  const entity = meta.split('|').slice(1).join('|').trim()
  return !entity || /^amazon\b/i.test(entity) ? 'Amazon' : entity
}

const SECTIONS = /^(description|basic qualifications|preferred qualifications)$/i

/** The job on a posting page, or null on any other page. */
export function amazonPosting(doc: Document, url: URL): Partial<Posting> | null {
  const id = amazonJobId(url)
  const title = doc.querySelector('#job-detail h1, .info h1.title, h1.title')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  if (!id || !title) return null
  const description = Array.from(doc.querySelectorAll('#job-detail-body .section, #job-detail .section'))
    .filter((s) => SECTIONS.test(s.querySelector('h2, h3')?.textContent?.trim() ?? ''))
    .map((s) => cleanText(s))
    .filter(Boolean)
    .join('\n')
  const location = Array.from(doc.querySelectorAll('.location-icon .association-content li'))
    .map((li) => li.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter(Boolean)
    .join('; ')
  return {
    title,
    company: companyOf(doc.querySelector('.details-line .meta, .info .meta')?.textContent ?? ''),
    location,
    description,
    jobId: id,
    workMode: workModeOf(`${location}\n${description.slice(0, 1500)}`),
  }
}

/** The posting's own address, the one the sheet keeps. */
const postingUrl = (id: string) => `https://www.amazon.jobs/en/jobs/${id}`

const cache = new Map<string, Promise<Partial<Posting>>>()

export const amazon: Adapter = {
  name: 'Amazon',
  // Only postings and applications: the rest of the site (search, teams) is neither.
  detect: (url) => isAmazonJobs(url) && (Boolean(amazonJobId(url)) || /\/applicant(\/|$)/.test(url.pathname)),
  posting(doc, url) {
    const own = amazonPosting(doc, url)
    if (own) return own
    // An application step: the posting behind it, read once.
    const id = amazonJobId(url)
    if (!id) return {}
    let hit = cache.get(id)
    if (!hit) {
      hit = fetchPosting(postingUrl(id)).then((r) => (r ? (amazonPosting(r.doc, new URL(postingUrl(id))) ?? {}) : {}))
      cache.set(id, hit)
    }
    return hit.then((p) => ({ ...p, jobId: id }))
  },
  // Not your Applications page, which says "Application submitted" on every card.
  isConfirmation: (doc, url) => !isAmazonApplications(url) && genericConfirmation(doc),
}

export interface AmazonApplication {
  posting: Posting
  /** ISO date */
  date: string
}

/** Your Applications page (/applicant, /en-US/applicant/dashboard). */
export function isAmazonApplications(url: URL): boolean {
  return isAmazonJobs(url) && /\/applicant(\/dashboard)?\/?$/.test(url.pathname)
}

/** One card per application: title, "Job ID: …", "Applied: Nov 24, 2026", location. */
export function amazonApplications(doc: Document): AmazonApplication[] {
  const out: AmazonApplication[] = []
  for (const card of Array.from(doc.querySelectorAll('.application.card'))) {
    const text = (sel: string) => card.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    const id = text('.job-id').match(/\d{5,}/)?.[0] ?? ''
    const title = text('.job-title a') || text('.job-title')
    const date = toISODate(text('.application-date').replace(/^Applied:?\s*/i, ''))
    if (!id || !title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    out.push({ posting: mergePosting(postingUrl(id), { title, company: 'Amazon', location: text('.location-text'), jobId: id }), date })
  }
  return out
}

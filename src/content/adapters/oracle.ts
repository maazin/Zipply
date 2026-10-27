// Oracle Recruiting Cloud ("Candidate Experience"): careers sites on
// *.oraclecloud.com (under /hcmUI/CandidateExperience/) or on a company's own
// domain, which names the API host in <base data-apibaseurl>. A single-page app: yes/no questions are button
// pills, dropdowns are comboboxes over a grid (both handled in dom/), and the
// posting comes from the site's own public job API, which also works on the
// application pages where the description isn't shown.
import type { Posting } from '@/shared/types'
import type { Adapter } from './types'
import { genericConfirmation } from './types'
import { htmlToText } from '../posting'
import { companyFromSiteName } from '@/shared/text'
import { workModeOf } from '@/core/score/postingSignals'

const CX_PATH = /\/hcmUI\/CandidateExperience\//i

/** Job and site from ".../sites/CX_1001/job/210791916/apply/section/1". */
export function oracleJob(url: URL): { site: string; id: string } | null {
  const m = url.pathname.match(/\/sites\/([^/]+)\/(?:[^/]+\/)*?(?:job|requisitions\/preview)\/(\d+)/i)
  return m ? { site: m[1], id: m[2] } : null
}

type Json = Record<string, unknown>
const str = (x: unknown) => (typeof x === 'string' ? x : '')

/** The posting from the requisition API's answer. */
export function postingFromRequisition(item: Json, company: string): Partial<Posting> {
  const description = ['ExternalDescriptionStr', 'ExternalResponsibilitiesStr', 'ExternalQualificationsStr']
    .map((k) => htmlToText(str(item[k])))
    .filter(Boolean)
    .join('\n')
  const where = str(item.WorkplaceType)
  return {
    title: str(item.Title),
    company,
    location: str(item.PrimaryLocation),
    description,
    datePosted: str(item.ExternalPostedStartDate).slice(0, 10),
    employmentType: str(item.JobSchedule),
    jobId: String(item.Id ?? ''),
    workMode: workModeOf(where) || workModeOf(`${str(item.PrimaryLocation)}\n${description.slice(0, 1500)}`),
  }
}

/** The employer, from the site's name ("JPMC Candidate Experience page" → "JPMC"). */
function siteCompany(doc: Document): string {
  const ld = doc.querySelector('script[type="application/ld+json"]')?.textContent ?? ''
  const name = ld.match(/"hiringOrganization"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/)?.[1] ?? ''
    const fromTitle = doc.title.split(/\s[-|–]\s/).slice(-1)[0] ?? ''
  return companyFromSiteName(name || fromTitle.replace(/\s+Careers?$/i, ''))
}

const cache = new Map<string, Promise<Partial<Posting>>>()

/** Where the job API lives and which careers site this is. */
function apiFor(doc: Document, url: URL): { base: string; site: string; id: string } | null {
  const job = oracleJob(url)
  if (!job) return null
  const cfg = doc.querySelector<HTMLElement>('base[data-apibaseurl]')?.dataset
  return { base: (cfg?.apibaseurl || url.origin).replace(/:443$/, '').replace(/\/$/, ''), site: cfg?.sitenumber || job.site, id: job.id }
}

async function fetchRequisition(url: URL, doc: Document): Promise<Partial<Posting>> {
  const job = apiFor(doc, url)
  if (!job) return {}
  const key = `${job.base}|${job.site}|${job.id}`
  let hit = cache.get(key)
  if (!hit) {
    const api = `${job.base}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${job.id}%22,siteNumber=${encodeURIComponent(job.site)}`
    // Public data: sent without cookies, which a company domain's API host refuses cross-site.
    hit = fetch(api, { credentials: 'omit', headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { items?: Json[] } | null) => (data?.items?.[0] ? postingFromRequisition(data.items[0], siteCompany(doc)) : {}))
      .catch(() => ({}))
    cache.set(key, hit)
    // A failed lookup can be tried again on the next read.
    hit.then((p) => {
      if (!p.title) cache.delete(key)
    })
  }
  return hit
}

export const oracle: Adapter = {
  name: 'Oracle',
  detect: (url, doc) => CX_PATH.test(url.pathname) || Boolean(doc.querySelector('base[data-apibaseurl], script[src*="/oj-hcm-ce/"]')),
  posting: (doc, url) => fetchRequisition(url, doc),
  isConfirmation: (doc) => genericConfirmation(doc),
}

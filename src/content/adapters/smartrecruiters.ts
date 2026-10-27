// SmartRecruiters: postings on jobs.smartrecruiters.com/{Company}/{id}-{slug},
// applications ("Easy apply") on /oneclick-ui/company/{Company}/publication/{uuid}.
// The form is built from web components whose inputs live in shadow roots
// (read through queryDeep in dom/); the posting comes from SmartRecruiters'
// public postings API, which takes either ID and allows any origin.
import type { Posting } from '@/shared/types'
import type { Adapter } from './types'
import { genericConfirmation, mapBy } from './types'
import { htmlToText } from '../posting'
import { workModeOf } from '@/core/score/postingSignals'

/** Company and posting from either address. */
export function smartRecruitersJob(url: URL): { company: string; id: string } | null {
  const apply = url.pathname.match(/\/oneclick-ui\/company\/([^/]+)\/publication\/([0-9a-f-]{36})/i)
  if (apply) return { company: decodeURIComponent(apply[1]), id: apply[2] }
  const posting = url.pathname.match(/^\/([^/]+)\/(\d{6,})(?:-|$)/)
  return posting && posting[1] !== 'oneclick-ui' ? { company: decodeURIComponent(posting[1]), id: posting[2] } : null
}

type Json = Record<string, unknown>
const obj = (x: unknown) => (x && typeof x === 'object' ? (x as Json) : {})
const str = (x: unknown) => (typeof x === 'string' ? x : '')

/** The posting from the API's answer. */
export function postingFromSmartRecruiters(d: Json): Partial<Posting> {
  const sections = obj(obj(d.jobAd).sections)
  const description = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription']
    .map((k) => htmlToText(str(obj(sections[k]).text)))
    .filter(Boolean)
    .join('\n')
  const loc = obj(d.location)
  const location = str(loc.fullLocation) || [loc.city, loc.region].map(str).filter(Boolean).join(', ')
  return {
    title: str(d.name),
    company: str(obj(d.company).name),
    location,
    description,
    datePosted: str(d.releasedDate).slice(0, 10),
    employmentType: str(obj(d.typeOfEmployment).label),
    jobId: str(d.id),
    workMode: loc.remote === true ? 'remote' : loc.hybrid === true ? 'hybrid' : workModeOf(`${location}\n${description.slice(0, 1500)}`),
  }
}

const cache = new Map<string, Promise<Partial<Posting>>>()

function fetchPosting(url: URL, doc: Document): Partial<Posting> | Promise<Partial<Posting>> {
  const job = smartRecruitersJob(url)
  // "Easy apply - Data Analyst - Globex" until the API answers (or if it doesn't).
  const [, title = '', company = ''] = doc.title.match(/^(?:Easy apply|Apply)\s+-\s+(.+)\s+-\s+([^-]+)$/i) ?? []
  const fallback = { title: title.trim(), company: company.trim() || job?.company || '' }
  if (!job) return fallback
  const key = `${job.company}|${job.id}`
  let hit = cache.get(key)
  if (!hit) {
    hit = fetch(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(job.company)}/postings/${job.id}`, { credentials: 'omit', headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Json | null) => (d ? postingFromSmartRecruiters(d) : fallback))
      .catch(() => fallback)
    cache.set(key, hit)
    // A failed lookup can be tried again on the next read.
    hit.then((p) => {
      if (!p.description) cache.delete(key)
    })
  }
  return hit
}

export const smartrecruiters: Adapter = {
  name: 'SmartRecruiters',
  hosts: /(^|\.)(smartrecruiters\.com|smartr\.me)$/i,
  detect: (url) => /(^|\.)(smartrecruiters\.com|smartr\.me)$/i.test(url.hostname),
  // The component IDs are stable across companies.
  explicit: (fields) => {
    const m = mapBy(
      fields,
      [
        [/^first-name-input$/, 'firstName'],
        [/^last-name-input$/, 'lastName'],
        [/^email-input$/, 'email'],
        [/^linkedin-input$/, 'linkedin'],
        [/^website-input$/, 'portfolio'],
      ],
      (c) => c.desc.idAttr,
    )
    // "Confirm your email" takes the same address (mapBy gives each key one field).
    const confirm = fields.find((c) => c.desc.idAttr === 'confirm-email-input')
    if (confirm) m.set(confirm.desc.zid, 'email')
    return m
  },
  posting: (doc, url) => fetchPosting(url, doc),
  isConfirmation: (doc) => genericConfirmation(doc),
}

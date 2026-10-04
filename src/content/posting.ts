// Read the job posting from the page: schema.org JobPosting JSON-LD first (most
// ATS publish it), then adapter selectors, then generic page text.
import type { Posting } from '@/shared/types'
import { parseSalary, workModeOf } from '@/core/score/postingSignals'

type Json = Record<string, unknown>

/** HTML to readable lines. Parsed in an inert document, so nothing loads or runs. */
export function htmlToText(html: string, depth = 0): string {
  const marked = html.replace(/<(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '$&\n').replace(/<li[^>]*>/gi, '\n- ')
  const doc = new DOMParser().parseFromString(marked, 'text/html')
  doc.querySelectorAll('script, style').forEach((n) => n.remove())
  const text = (doc.body?.textContent ?? '').replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
  // Some JSON-LD descriptions are HTML-escaped twice.
  return depth < 1 && /<(p|li|ul|br|div|strong)\b[^>]*>/i.test(text) ? htmlToText(text, depth + 1) : text
}

function asArray<T>(x: T | T[] | undefined): T[] {
  return x == null ? [] : Array.isArray(x) ? x : [x]
}

function findJobPosting(node: unknown): Json | null {
  for (const n of asArray(node as Json | Json[])) {
    if (!n || typeof n !== 'object') continue
    const type = asArray(n['@type'] as string | string[])
    if (type.includes('JobPosting')) return n
    const inner = findJobPosting(n['@graph'])
    if (inner) return inner
  }
  return null
}

function str(x: unknown): string {
  return typeof x === 'string' ? x : typeof x === 'number' ? String(x) : ''
}

export function postingFromJsonLd(doc: Document = document): Partial<Posting> | null {
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    let data: unknown
    try {
      data = JSON.parse(s.textContent ?? '')
    } catch {
      continue
    }
    const jp = findJobPosting(data)
    if (!jp) continue
    const org = jp.hiringOrganization as Json | undefined
    const locs = asArray(jp.jobLocation as Json | Json[])
    const addr = (locs[0]?.address ?? {}) as Json
    const location = [str(addr.addressLocality), str(addr.addressRegion)].filter(Boolean).join(', ') || str(addr.addressCountry)
    const remote = str(jp.jobLocationType).toUpperCase() === 'TELECOMMUTE'
    const id = jp.identifier as Json | string | undefined
    const base = jp.baseSalary as Json | undefined
    const value = (base?.value ?? {}) as Json
    const salary =
      typeof value.minValue === 'number' && typeof value.maxValue === 'number'
        ? {
            min: value.minValue,
            max: value.maxValue,
            currency: str(base?.currency) || 'USD',
            period: (/HOUR/i.test(str(value.unitText)) ? 'hour' : /MONTH/i.test(str(value.unitText)) ? 'month' : 'year') as 'hour' | 'month' | 'year',
          }
        : null
    const description = htmlToText(str(jp.description))
    return {
      title: str(jp.title),
      company: str(org?.name),
      location: remote && !location ? 'Remote' : location,
      description,
      datePosted: str(jp.datePosted).slice(0, 10),
      salary: salary ?? parseSalary(description),
      employmentType: asArray(jp.employmentType as string | string[]).join(', '),
      jobId: typeof id === 'object' && id ? str(id.value) : str(id),
      workMode: remote ? 'remote' : workModeOf(`${location}\n${description.slice(0, 1500)}`),
    }
  }
  return null
}

/** Merge partial postings, earlier sources win for non-empty values. */
export function mergePosting(url: string, ...parts: (Partial<Posting> | null | undefined)[]): Posting {
  const out: Posting = { title: '', company: '', location: '', description: '', datePosted: '', salary: null, employmentType: '', jobId: '', url, workMode: '' }
  for (const p of parts) {
    if (!p) continue
    for (const [k, v] of Object.entries(p) as [keyof Posting, Posting[keyof Posting]][]) {
      if ((out[k] === '' || out[k] == null) && v !== '' && v != null) (out as unknown as Record<string, unknown>)[k] = v
    }
  }
  if (!out.salary && out.description) out.salary = parseSalary(out.description)
  if (!out.workMode) out.workMode = workModeOf(`${out.location}\n${out.description.slice(0, 1500)}`)
  return out
}

/** Text of the first matching element, as readable lines. */
export function textAt(doc: Document, selectors: string[]): string {
  for (const sel of selectors) {
    const el = doc.querySelector<HTMLElement>(sel)
    const t = el ? htmlToText(el.innerHTML) : ''
    if (t) return t
  }
  return ''
}

/** Generic fallback: title from h1 / og:title / document.title, description from the main text block. */
export function genericPosting(doc: Document = document): Partial<Posting> {
  const og = (p: string) => doc.querySelector<HTMLMetaElement>(`meta[property="${p}"], meta[name="${p}"]`)?.content ?? ''
  const h1 = doc.querySelector('h1')?.textContent?.trim() ?? ''
  const title = h1 || og('og:title') || doc.title.split(/\s[-|–]\s/)[0]
  const site = og('og:site_name') || doc.title.split(/\s[-|–]\s/).slice(-1)[0] || ''
  let best = ''
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('main, article, [class*="description" i], [id*="description" i], section'))) {
    const t = htmlToText(el.innerHTML)
    if (/responsibilit|requirement|qualification|what you/i.test(t) && t.length > best.length && t.length < 30000) best = t
  }
  return { title: title.slice(0, 140), company: site !== title ? site : '', description: best }
}

/** Fetch a same-origin page (e.g. the posting behind an /apply URL) and parse it. */
export async function fetchPosting(url: string): Promise<{ doc: Document; ld: Partial<Posting> | null } | null> {
  try {
    if (new URL(url).origin !== location.origin) return null
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) return null
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
    return { doc, ld: postingFromJsonLd(doc) }
  } catch {
    return null
  }
}

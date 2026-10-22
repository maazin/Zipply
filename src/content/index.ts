// Content script. Stays invisible: no buttons or banners on job sites. It
// reports what it finds to the service worker (for the toolbar dot), fills when
// you press "Fill this page", keeps filling each new step of a multi-page flow,
// and logs the job when the confirmation page appears.
import type { FieldReport, Posting } from '@/shared/types'
import type { FillContext, PageToContent, ScanResult } from '@/shared/messages'
import { isError, send } from '@/shared/messages'
import { canonicalUrl } from '@/core/score/applied'
import { pickAdapter, type Adapter } from './adapters'
import { collectFields, findByZid } from './dom/collect'
import { flash, setText } from './dom/setValue'
import { fillPage, lastReports, refreshMissing, tracked, watchAnswers } from './fill'
import { genericPosting, mergePosting, postingFromJsonLd } from './posting'
import { detectApplication } from './detect'
import { sanitizeForm } from './capture'
import { clearStale, decorateCards, listingPosting, pillFor, placePill, siteFor, type ListingScore } from './listings'

declare global {
  interface Window {
    __zipply?: boolean
  }
}

/** Auto-fill after you press Fill. Kept per tab by the service worker, so it
 * survives "Apply" taking you to another site. */
let auto: { resumeId: string | null } | null = null

function autoFill(): { resumeId: string | null } | null {
  return auto
}

function setAuto(next: { resumeId: string | null } | null) {
  auto = next
  send(next ? { type: 'auto:set', resumeId: next.resumeId } : { type: 'auto:clear' }).catch(() => undefined)
}

function main() {
  let adapter: Adapter = pickAdapter(new URL(location.href), document)
  let posting: { url: string; value: Posting } | null = null
  let confirmedFor = ''
  let lastStatus = ''
  let filling = false
  const done = new Set<string>()
  // Zipply runs on every site but stays idle until the page looks like an
  // application (or you filled here earlier in this tab).
  let active = false
  let reported = false

  function checkActive(): boolean {
    if (!active) active = Boolean(autoFill()) || detectApplication(document, new URL(location.href)).isApplication
    return active
  }

  async function getPosting(): Promise<Posting | null> {
    const key = canonicalUrl(location.href)
    if (posting?.url === key) return posting.value
    const url = new URL(location.href)
    const site = siteFor(url)
    const listing = site ? listingPosting(site, document, url) : null
    const value = mergePosting(listing?.url ?? location.href, listing, postingFromJsonLd(document), await adapter.posting?.(document, url), genericPosting(document))
    if (!value.title && !value.company && !value.description) return null
    posting = { url: key, value }
    return value
  }

  /** A job description page with no form: tell the service worker, once per page, for the "Apply" that follows. */
  let seenJob = ''
  function noteJobPage() {
    if (window !== window.top || siteFor(new URL(location.href))) return
    const key = canonicalUrl(location.href)
    if (seenJob === key) return
    const p = postingFromJsonLd(document)
    if (!p || (!p.title && !p.company) || (p.description ?? '').length < 200) return
    seenJob = key
    send({ type: 'job:seen', posting: mergePosting(location.href, p) }).catch(() => undefined)
  }

  function fieldCount(): number {
    return collectFields(document).filter((c) => c.desc.kind !== 'file' || c.desc.label).length
  }

  async function report() {
    adapter = pickAdapter(new URL(location.href), document)
    // Confirmation pages have no form, so they count when this is a known ATS
    // or you filled an application in this tab.
    const filledHere = Boolean(autoFill())
    const confirmation = (adapter.name !== 'Other' || filledHere) && adapter.isConfirmation(document, new URL(location.href))
    if (!confirmation && !checkActive()) {
      noteJobPage()
      if (reported) {
        reported = false
        lastStatus = ''
        send({ type: 'frame:status', ats: adapter.name, fields: 0, confirmation: false, posting: null }).catch(() => undefined)
      }
      return
    }
    reported = true
    const fields = confirmation ? 0 : fieldCount()
    const status = `${adapter.name}|${fields}|${confirmation}|${location.href}`
    if (status !== lastStatus) {
      lastStatus = status
      const p = window === window.top || fields > 0 ? await getPosting().catch(() => null) : null
      send({ type: 'frame:status', ats: adapter.name, fields, confirmation, posting: p }).catch(() => undefined)
    }
    if (confirmation && confirmedFor !== location.href) {
      confirmedFor = location.href
      setAuto(null)
      send({ type: 'submit:confirmed', ats: adapter.name, url: location.href, posting: await getPosting().catch(() => null) }).catch(() => undefined)
    }
  }

  async function context(resumeId: string | null): Promise<FillContext> {
    const ctx = await send<FillContext | { error: string; locked?: boolean }>({ type: 'fill:context', resumeId })
    if (isError(ctx)) throw new Error(ctx.error)
    return ctx
  }

  async function run(resumeId: string | null, auto: boolean): Promise<FieldReport[]> {
    if (filling) return lastReports
    filling = true
    try {
      const ctx = await context(resumeId)
      const reports = await fillPage(adapter, ctx, document, auto ? done : new Set())
      reports.forEach((r) => r.zid && done.add(r.zid))
      send({ type: 'fill:done', reports, auto }).catch(() => undefined)
      return reports
    } finally {
      filling = false
    }
  }

  // Multi-page flows: when a new step renders, fill the new fields too.
  // Idle pages are re-checked at most every 2 s, so busy sites stay fast.
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastIdleCheck = 0
  const observer = new MutationObserver(() => {
    if (!active && !reported) {
      if (timer) return
      const wait = Math.max(0, 2000 - (Date.now() - lastIdleCheck))
      timer = setTimeout(async () => {
        timer = undefined
        lastIdleCheck = Date.now()
        await report()
      }, wait)
      return
    }
    clearTimeout(timer)
    timer = setTimeout(async () => {
      timer = undefined
      await report()
      const auto = autoFill()
      if (!auto || filling) return
      const fresh = collectFields(document).filter((c) => !done.has(c.desc.zid) && !c.desc.value)
      if (fresh.length >= 2) {
        await run(auto.resumeId, true).catch(() => undefined)
      }
    }, 900)
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })

  let changeTimer: ReturnType<typeof setTimeout> | undefined
  watchAnswers(document, () => {
    clearTimeout(changeTimer)
    changeTimer = setTimeout(() => {
      if (!lastReports.length) return
      send({ type: 'report:update', reports: refreshMissing(lastReports) }).catch(() => undefined)
    }, 400)
  })

  chrome.runtime.onMessage.addListener((msg: PageToContent, _sender, reply) => {
    ;(async () => {
      switch (msg.type) {
        case 'scan':
          return {
            ats: adapter.name,
            fields: fieldCount(),
            confirmation: adapter.isConfirmation(document, new URL(location.href)),
            posting: await getPosting(),
          } satisfies ScanResult
        case 'fill':
          setAuto({ resumeId: msg.resumeId })
          active = true
          return { reports: await run(msg.resumeId, false) }
        case 'focus': {
          const el = findByZid(msg.zid)
          if (!el) return { ok: false }
          flash(el)
          return { ok: true }
        }
        case 'insert': {
          const target = Array.from(tracked.values()).find((t) => /cover letter/i.test(t.c.desc.label) && t.c.desc.kind === 'textarea')
          const el = (target?.c.el as HTMLElement | undefined) ?? collectFields(document).find((c) => /cover letter/i.test(c.desc.label) && c.desc.kind === 'textarea')?.el
          if (!el) return { ok: false }
          setText(el as HTMLElement, msg.text)
          flash(el as HTMLElement)
          return { ok: true }
        }
        case 'capture':
          return { html: sanitizeForm(document, location.href), fields: fieldCount() }
        case 'stop':
          setAuto(null)
          return { ok: true }
      }
    })()
      .then(reply)
      .catch((e) => reply({ error: e instanceof Error ? e.message : String(e) }))
    return true
  })

  // Match scores on LinkedIn and Indeed listings (top frame only).
  const scores = new Map<string, ListingScore>()
  const asked = new Set<string>()
  let listingsOff = false
  let seenListing = ''
  async function tickListings() {
    const url = new URL(location.href)
    const site = siteFor(url)
    if (!site || window !== window.top) return
    const p = listingPosting(site, document, url)
    // The job you have open is the one "Apply" is for.
    if (p && seenListing !== p.jobId) {
      seenListing = p.jobId
      send({ type: 'job:seen', posting: p }).catch(() => undefined)
    }
    if (listingsOff) return
    if (p && !scores.has(p.jobId) && !asked.has(p.jobId)) {
      asked.add(p.jobId)
      const r = await send<ListingScore | { disabled: true } | { error: string }>({ type: 'score:posting', posting: p }).catch(() => null)
      if (r && 'disabled' in r) listingsOff = true
      else if (r && !isError(r)) scores.set(p.jobId, r)
      else asked.delete(p.jobId)
    }
    const s = p ? scores.get(p.jobId) : undefined
    const title = document.querySelector(site.title)
    // The detail pane is reused: drop the last job's pill as soon as another opens.
    clearStale(title, site.jobId(url, document))
    if (p && s && title && !pillFor(title, p.jobId)) placePill(title, p.jobId, s)
    decorateCards(site, document, scores)
  }
  if (siteFor(new URL(location.href))) {
    let listingTimer: ReturnType<typeof setTimeout> | undefined
    new MutationObserver(() => {
      if (listingTimer) return
      listingTimer = setTimeout(() => {
        listingTimer = undefined
        void tickListings()
      }, 800)
    }).observe(document.documentElement, { childList: true, subtree: true })
    void tickListings()
  }

  // Check right away: a confirmation page may be closed within a second.
  // First learn whether you pressed Fill earlier in this tab (maybe on another site).
  void send<{ resumeId: string | null } | null>({ type: 'auto:get' })
    .then((a) => {
      if (a && 'resumeId' in a) auto = a
    })
    .catch(() => undefined)
    .finally(() => void report())
  // And as the tab closes or goes to the background, in case it changed since.
  const lastLook = () => void report()
  addEventListener('pagehide', lastLook)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && lastLook())

  // Re-entering a multi-page flow on a fresh page load (iCIMS): keep going.
  setTimeout(async () => {
    await report()
    const auto = autoFill()
    if (auto && fieldCount() >= 2) await run(auto.resumeId, true).catch(() => undefined)
  }, 1200)
}

if (!window.__zipply) {
  window.__zipply = true
  main()
}

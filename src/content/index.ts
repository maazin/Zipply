// Content script. On job pages it adds only the small Zipply tab at the right
// edge (it opens the panel); nothing else is drawn on job sites. It reports
// what it finds to the service worker (for the toolbar dot), fills when you
// press "Fill this page", keeps filling each new step of a multi-page flow,
// and logs the job when the confirmation page appears.
import type { FieldReport, Posting } from '@/shared/types'
import type { FillContext, PageToContent, ScanResult } from '@/shared/messages'
import { isError, send } from '@/shared/messages'
import { canonicalUrl } from '@/core/score/applied'
import { pickAdapter, type Adapter } from './adapters'
import { collectFields, findByZid } from './dom/collect'
import { flash } from './dom/setValue'
import { askField, fillPage, lastReports, refreshMissing, watchChanges } from './fill'
import { genericPosting, mergePosting, postingFromJsonLd } from './posting'
import { detectApplication } from './detect'
import { sanitizeForm } from './capture'
import { amazonApplications, isAmazonApplications } from './adapters/amazon'
import { showApplied, showSideTab, watchSideTab } from './sideTab'
import { clearStale, decorateCards, handshakeApplications, isHandshakeApplications, isLinkedInApplications, isListingHost, linkedinApplications, listingPosting, pillFor, placePill, siteFor, titleFor, type ListingScore } from './listings'

declare global {
  interface Window {
    /** Set by the running copy. `true` is from a build before the liveness check. */
    __zipply?: boolean | { alive: () => boolean }
  }
}

/**
 * When Zipply reloads (an update), the copy already in a page stays but can no
 * longer reach the extension. Only a copy that can is counted as running.
 */
function zipplyAlive(): boolean {
  const z = window.__zipply
  if (!z || z === true) return false
  try {
    return z.alive()
  } catch {
    return false
  }
}

/** This copy lost its extension (Zipply reloaded): stop watching the page. */
const orphaned = () => {
  try {
    return !chrome.runtime?.id
  } catch {
    return true
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
  // You filled an application in this tab (on this page or an earlier one) that isn't logged yet.
  let filledHere = false
  let lastStatus = ''
  let filling = false
  // You pressed Pause: stop between fields, and don't fill the next steps.
  let paused = false
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
    const url = new URL(location.href)
    const site = siteFor(url)
    // Listing panes (LinkedIn, Indeed, Handshake) swap jobs without a page load,
    // so they're read fresh every time; other pages are read once per address.
    if (!site && posting?.url === key) return posting.value
    const listing = site ? listingPosting(site, document, url) : null
    // A listing still loading: wait, rather than take the page's own heading ("Jobs").
    if (site && !listing) return null
    const ld = postingFromJsonLd(document)
    const own = await adapter.posting?.(document, url)
    const generic = genericPosting(document)
    // Only the page's heading to go on, no job description and no form (a search
    // page, a home page): that's not a job, so the panel shows the page itself.
    if (!listing && !ld && !own?.title && !own?.company && !generic.description && fieldCount() === 0) return null
    const value = mergePosting(listing?.url ?? location.href, listing, ld, own, generic)
    if (!value.title && !value.company && !value.description) return null
    if (!site) posting = { url: key, value }
    return value
  }

  /**
   * Say beside the Zipply tab when you've applied to this job before, with the
   * date. Asked once per posting; a new posting with no match clears it.
   */
  let appliedFor = ''
  function lookupApplied(p: Posting | null) {
    if (window !== window.top || !p || (!p.company && !p.title)) return
    const key = `${p.company}|${p.title}|${p.jobId}|${canonicalUrl(p.url)}`
    if (appliedFor === key) return
    appliedFor = key
    send<{ text: string; sure: boolean } | null>({ type: 'applied:lookup', posting: p })
      .then((line) => appliedFor === key && showApplied(line ?? null))
      .catch(() => undefined)
  }

  /** A job description page with no form: tell the service worker, once per page, for the "Apply" that follows. */
  let seenJob = ''
  async function noteJobPage() {
    const url = new URL(location.href)
    if (window !== window.top || siteFor(url)) return
    const key = canonicalUrl(location.href)
    if (seenJob === key) return
    // Structured data, else a reader for this site's own postings (Amazon has no structured data).
    const own = adapter.name !== 'Other' ? await Promise.resolve(adapter.posting?.(document, url)).catch(() => null) : null
    const p = mergePosting(location.href, postingFromJsonLd(document), own)
    if (seenJob === key || (!p.title && !p.company) || p.description.length < 200) return
    seenJob = key
    void showSideTab('job')
    const posting = p
    send({ type: 'job:seen', posting }).catch(() => undefined)
    lookupApplied(posting)
  }

  function fieldCount(): number {
    return collectFields(document).filter((c) => c.desc.kind !== 'file' || c.desc.label).length
  }

  async function report() {
    adapter = pickAdapter(new URL(location.href), document)
    // Confirmation pages have no form, so they count when this is a known ATS
    // or you filled an application in this tab.
    const confirmation = (adapter.name !== 'Other' || filledHere || Boolean(autoFill())) && adapter.isConfirmation(document, new URL(location.href))
    if (!confirmation && !checkActive()) {
      void noteJobPage()
      if (reported) {
        reported = false
        lastStatus = ''
        send({ type: 'frame:status', ats: adapter.name, fields: 0, confirmation: false, posting: null }).catch(() => undefined)
      }
      return
    }
    reported = true
    const fields = confirmation ? 0 : fieldCount()
    if (!confirmation) void showSideTab(fields > 0 ? 'form' : 'job')
    const status = `${adapter.name}|${fields}|${confirmation}|${location.href}`
    if (status !== lastStatus) {
      lastStatus = status
      const p = window === window.top || fields > 0 ? await getPosting().catch(() => null) : null
      send({ type: 'frame:status', ats: adapter.name, fields, confirmation, posting: p }).catch(() => undefined)
      if (!confirmation) lookupApplied(p)
    }
    if (confirmation && confirmedFor !== location.href) {
      confirmedFor = location.href
      filledHere = false
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
      // Drafts for open questions arrive afterwards, one update each.
      const reports = await fillPage(adapter, ctx, document, auto ? done : new Set(), {
        onDrafts: (drafted) => void send({ type: 'report:update', reports: drafted }).catch(() => undefined),
        stopped: () => paused,
      })
      reports.forEach((r) => r.zid && done.add(r.zid))
      filledHere = true
      // With the posting, so the job is known even if nothing read it before.
      const p = window === window.top || reports.length ? await getPosting().catch(() => null) : null
      send({ type: 'fill:done', reports, auto, ats: adapter.name, posting: p }).catch(() => undefined)
      return reports
    } finally {
      filling = false
    }
  }

  // Multi-page flows: when a new step renders, fill the new fields too.
  // Idle pages are re-checked at most every 2 s, so busy sites stay fast.
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastIdleCheck = 0
  // Waits for the page to settle, but no longer than this: Workday keeps
  // changing the page, and a plain debounce never ran on its later steps.
  const MAX_WAIT = 2500
  let changedSince = 0
  const observer = new MutationObserver(() => {
    if (orphaned()) return observer.disconnect()
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
    changedSince ||= Date.now()
    timer = setTimeout(async () => {
      timer = undefined
      changedSince = 0
      await report()
      const auto = autoFill()
      if (!auto || filling) return
      const fresh = collectFields(document).filter((c) => !done.has(c.desc.zid) && !c.desc.value)
      if (fresh.length >= 2) {
        await run(auto.resumeId, true).catch(() => undefined)
      }
    }, Math.min(900, Math.max(0, MAX_WAIT - (Date.now() - changedSince))))
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })

  let changeTimer: ReturnType<typeof setTimeout> | undefined
  watchChanges(document, () => {
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
          paused = false
          setAuto({ resumeId: msg.resumeId })
          active = true
          return { reports: await run(msg.resumeId, false) }
        case 'focus': {
          const el = findByZid(msg.zid)
          if (!el) return { ok: false }
          flash(el)
          return { ok: true }
        }
        case 'capture':
          return { html: sanitizeForm(document, location.href), fields: fieldCount() }
        case 'ask': {
          const r = await askField(msg.zid)
          if (!isError(r)) send({ type: 'report:update', reports: [r] }).catch(() => undefined)
          return r
        }
        case 'stop':
          paused = true
          setAuto(null)
          return { ok: true }
      }
    })()
      .then(reply)
      .catch((e) => reply({ error: e instanceof Error ? e.message : String(e) }))
    return true
  })

  // Match scores on LinkedIn, Indeed and Handshake listings (top frame only).
  const scores = new Map<string, ListingScore>()
  const asked = new Set<string>()
  let listingsOff = false
  let seenListing = ''
  // Applications already reported from this page, so each is sent once.
  const reportedApplied = new Set<string>()
  function reportApplied(jobs: { posting: Posting; date: string }[]) {
    const fresh = jobs.filter((j) => !reportedApplied.has(`${j.posting.jobId}|${j.date}`))
    if (!fresh.length) return
    fresh.forEach((j) => reportedApplied.add(`${j.posting.jobId}|${j.date}`))
    send({ type: 'job:applied', jobs: fresh }).catch(() => fresh.forEach((j) => reportedApplied.delete(`${j.posting.jobId}|${j.date}`)))
  }
  async function tickListings() {
    const url = new URL(location.href)
    if (window !== window.top) return
    // Handshake applies inside its own page, with no confirmation page to see:
    // its list of your applications, and the "Applied on" line on a job, say so.
    if (isHandshakeApplications(url)) return reportApplied(handshakeApplications(document))
    // LinkedIn's Easy Apply has no confirmation page either; its Job tracker lists what you applied to.
    if (isLinkedInApplications(url)) return reportApplied(linkedinApplications(document))
    // So does your Applications page on amazon.jobs.
    if (isAmazonApplications(url)) return reportApplied(amazonApplications(document))
    const site = siteFor(url)
    if (!site) return
    const p = listingPosting(site, document, url)
    // The job you have open is the one "Apply" is for.
    if (p && seenListing !== p.jobId) {
      seenListing = p.jobId
      void showSideTab('job')
      send({ type: 'job:seen', posting: p }).catch(() => undefined)
    }
    // The detail pane is reused for the next job, so this follows the job shown.
    lookupApplied(p)
    const appliedOn = p ? site.appliedOn?.(document, p.jobId) : ''
    if (p && appliedOn) reportApplied([{ posting: p, date: appliedOn }])
    if (listingsOff) return
    if (p && !scores.has(p.jobId) && !asked.has(p.jobId)) {
      asked.add(p.jobId)
      const r = await send<ListingScore | { disabled: true } | { error: string }>({ type: 'score:posting', posting: p }).catch(() => null)
      if (r && 'disabled' in r) listingsOff = true
      else if (r && !isError(r)) scores.set(p.jobId, r)
      else asked.delete(p.jobId)
    }
    const s = p ? scores.get(p.jobId) : undefined
    const shown = site.jobId(url, document)
    const title = titleFor(site, document, shown)
    // The detail pane is reused: drop the last job's pill as soon as another opens.
    clearStale(title, shown)
    if (p && s && title && !pillFor(title, p.jobId)) placePill(title, p.jobId, s)
    decorateCards(site, document, scores)
  }
  if (isListingHost(new URL(location.href))) {
    // Pills a previous copy left (before Zipply reloaded) may be stale: start clean.
    document.querySelectorAll('[data-zipply-pill]').forEach((p) => p.remove())
    let listingTimer: ReturnType<typeof setTimeout> | undefined
    const listingObserver = new MutationObserver(() => {
      if (orphaned()) return listingObserver.disconnect()
      if (listingTimer) return
      listingTimer = setTimeout(() => {
        listingTimer = undefined
        void tickListings()
      }, 800)
    })
    listingObserver.observe(document.documentElement, { childList: true, subtree: true })
    void tickListings()
  }

  watchSideTab()
  // A job page on a known applicant system (Greenhouse, Lever…) gets the tab even before its form shows.
  if (adapter.name !== 'Other') void showSideTab('job')

  // Check right away: a confirmation page may be closed within a second.
  // First learn whether you pressed Fill earlier in this tab (maybe on another site).
  void send<{ auto: { resumeId: string | null } | null; filled: boolean } | null>({ type: 'auto:get' })
    .then((a) => {
      if (a?.auto) auto = a.auto
      if (a?.filled) filledHere = true
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

if (!zipplyAlive()) {
  window.__zipply = { alive: () => !orphaned() }
  main()
}

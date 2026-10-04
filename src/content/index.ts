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

declare global {
  interface Window {
    __zipply?: boolean
  }
}

const AUTO_KEY = 'zipply-auto'

function main() {
  let adapter: Adapter = pickAdapter(new URL(location.href), document)
  let posting: { url: string; value: Posting } | null = null
  let confirmedFor = ''
  let lastStatus = ''
  let filling = false
  const done = new Set<string>()

  async function getPosting(): Promise<Posting | null> {
    const key = canonicalUrl(location.href)
    if (posting?.url === key) return posting.value
    const url = new URL(location.href)
    const value = mergePosting(location.href, postingFromJsonLd(document), await adapter.posting?.(document, url), genericPosting(document))
    if (!value.title && !value.company && !value.description) return null
    posting = { url: key, value }
    return value
  }

  function fieldCount(): number {
    return collectFields(document).filter((c) => c.desc.kind !== 'file' || c.desc.label).length
  }

  async function report() {
    adapter = pickAdapter(new URL(location.href), document)
    const confirmation = adapter.isConfirmation(document, new URL(location.href))
    const fields = confirmation ? 0 : fieldCount()
    const status = `${adapter.name}|${fields}|${confirmation}|${location.href}`
    if (status !== lastStatus) {
      lastStatus = status
      const p = window === window.top || fields > 0 ? await getPosting().catch(() => null) : null
      send({ type: 'frame:status', ats: adapter.name, fields, confirmation, posting: p }).catch(() => undefined)
    }
    if (confirmation && confirmedFor !== location.href) {
      confirmedFor = location.href
      sessionStorage.removeItem(AUTO_KEY)
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
  let timer: ReturnType<typeof setTimeout> | undefined
  const observer = new MutationObserver(() => {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      await report()
      const auto = sessionStorage.getItem(AUTO_KEY)
      if (!auto || filling) return
      const fresh = collectFields(document).filter((c) => !done.has(c.desc.zid) && !c.desc.value)
      if (fresh.length >= 2) {
        const { resumeId } = JSON.parse(auto) as { resumeId: string | null }
        await run(resumeId, true).catch(() => undefined)
      }
    }, 900)
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })

  let changeTimer: ReturnType<typeof setTimeout> | undefined
  watchAnswers(document, () => {
    clearTimeout(changeTimer)
    changeTimer = setTimeout(() => {
      const reports = refreshMissing(lastReports)
      send({ type: 'fill:done', reports, auto: true }).catch(() => undefined)
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
          sessionStorage.setItem(AUTO_KEY, JSON.stringify({ resumeId: msg.resumeId }))
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
        case 'stop':
          sessionStorage.removeItem(AUTO_KEY)
          return { ok: true }
      }
    })()
      .then(reply)
      .catch((e) => reply({ error: e instanceof Error ? e.message : String(e) }))
    return true
  })

  // Re-entering a multi-page flow on a fresh page load (iCIMS): keep going.
  setTimeout(async () => {
    await report()
    const auto = sessionStorage.getItem(AUTO_KEY)
    if (auto && fieldCount() >= 2) await run((JSON.parse(auto) as { resumeId: string | null }).resumeId, true).catch(() => undefined)
  }, 1200)
}

if (!window.__zipply) {
  window.__zipply = true
  main()
}

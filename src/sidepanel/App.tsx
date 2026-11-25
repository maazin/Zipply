import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppliedEntry, FieldReport, Posting, Profile, ResumeMeta, Settings, StatusEvent, UnmatchedEmail } from '@/shared/types'
import type { AiText, FrameInfo, JobContext, LogResult, ScanResult } from '@/shared/messages'
import { isError, send, sendToFrame } from '@/shared/messages'
import { computeVerdict } from '@/core/score/verdict'
import { appliedLine } from '@/core/score/applied'
import { getProfile, listResumes } from '@/lib/repo'
import { isLocked, unlock } from '@/lib/keys'
import { runChecks, type ChecksResult } from '@/lib/checks'
import { continuesJob, mergePostingInto } from '@/core/jobContext'
import { ResumeRanking } from '@/ui/ResumeRanking'
import { sinceSummary } from './since'
import { db, type UnloggedRow } from '@/lib/db'
import { Button, Card, Chip, Dot, Icon, Input, Label, Logo, ScoreRing, Select, Spinner, TextArea, cx } from '@/ui/kit'
import contentScript from '@/content/index.ts?script'
import { scrubPersonal } from '@/content/capture'
import { panelSkips } from '@/shared/excluded'

type Phase = 'loading' | 'locked' | 'setup' | 'unsupported' | 'permission' | 'ready'

function openProfile() {
  chrome.runtime.openOptionsPage()
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  // ?tabId= pins the panel to one tab (used when the panel is opened as a page, e.g. in tests).
  const pinned = Number(new URLSearchParams(location.search).get('tabId'))
  if (pinned) return chrome.tabs.get(pinned)
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

/** Longest a fill may take before the panel stops waiting (drafts don't count: they arrive later). */
const FILL_MS = 90_000

async function tabState(tabId: number) {
  return send<{ frames: FrameInfo[]; job: JobContext | null; auto: boolean; queue: number; settings: Settings }>({ type: 'tab:state', tabId })
}

/**
 * Every frame in the tab, with the content script running in each. It's
 * declared for all sites, but pages opened before Zipply was installed or
 * reloaded don't have it yet, so it's injected where missing.
 */
async function ensureInjected(tabId: number): Promise<number[] | null> {
  try {
    // A copy left over from before Zipply reloaded is in the page but can't be reached: count only live ones.
    const probe = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const z = (window as { __zipply?: boolean | { alive: () => boolean } }).__zipply
        try {
          return typeof z === 'object' && z !== null && z.alive()
        } catch {
          return false
        }
      },
    })
    const missing = probe.filter((r) => !r.result).map((r) => r.frameId)
    if (missing.length) {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: missing }, files: [contentScript] })
      await new Promise((r) => setTimeout(r, 400))
    }
    return probe.map((r) => r.frameId)
  } catch {
    return null
  }
}

async function scanFrames(tabId: number, frameIds: number[]): Promise<{ frames: (FrameInfo & { scan: ScanResult | null })[]; posting: Posting | null; ats: ScanResult['ats'] }> {
  const frames: FrameInfo[] = frameIds.map((frameId) => ({ frameId, ats: 'Other', fields: 0, confirmation: false, url: '' }))
  const scanned = await Promise.all(frames.map(async (f) => ({ ...f, scan: await sendToFrame<ScanResult>(tabId, f.frameId, { type: 'scan' }).catch(() => null) })))
  const withPosting = scanned.filter((f) => f.scan?.posting).sort((a, b) => (b.scan!.posting!.description.length || 0) - (a.scan!.posting!.description.length || 0))
  const formFrame = [...scanned].sort((a, b) => (b.scan?.fields ?? 0) - (a.scan?.fields ?? 0))[0]
  return { frames: scanned, posting: withPosting[0]?.scan?.posting ?? null, ats: formFrame?.scan?.ats ?? 'Other' }
}

export function App() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [tab, setTab] = useState<chrome.tabs.Tab>()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [resumes, setResumes] = useState<ResumeMeta[]>([])
  const [posting, setPosting] = useState<Posting | null>(null)
  const [ats, setAts] = useState<ScanResult['ats']>('Other')
  const [frames, setFrames] = useState<FrameInfo[]>([])
  const [checks, setChecks] = useState<ChecksResult | null>(null)
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [reports, setReports] = useState<FieldReport[] | null>(null)
  const [filling, setFilling] = useState(false)
  const [logState, setLogState] = useState<LogResult | null>(null)
  const [queue, setQueue] = useState(0)
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)

  // Each load (a new page, tab or job) outdates the ones before it: a slow
  // scan of the last page mustn't land after the current one.
  const loadSeq = useRef(0)
  /** The load already re-run once because the page had something new to read. */
  const reread = useRef(-1)
  const postingRef = useRef<Posting | null>(null)
  postingRef.current = posting

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const stale = () => seq !== loadSeq.current
    setError('')
    setReports(null)
    setChecks(null)
    setLogState(null)
    if (await isLocked()) return setPhase('locked')
    const [p, rs] = await Promise.all([getProfile(), listResumes()])
    setProfile(p)
    setResumes(rs)
    if (!p.basics.firstName && !rs.length) return setPhase('setup')
    const t = await activeTab()
    setTab(t)
    // Sites Zipply skips (YouTube, Gmail, Docs…) stay untouched here too.
    // A page Zipply can't read shows nothing of the page before it.
    const nothing = (next: Phase) => {
      setPosting(null)
      setFrames([])
      setPhase(next)
    }
    if (!t?.id || panelSkips(t.url ?? '')) return nothing('unsupported')
    const frameIds = await ensureInjected(t.id)
    if (stale()) return
    if (!frameIds) return nothing('permission')
    const scan = await scanFrames(t.id, frameIds)
    const state = await tabState(t.id)
    if (stale()) return
    setFrames(scan.frames)
    setAts(scan.ats)
    setQueue(state.queue)
    setArmed(state.auto)
    // On the application form, keep the job you came from (its description,
    // score and resume ranking) rather than the bare form page.
    const job = state.job
    // The "thank you" page after a submit is still that job.
    const confirmed = scan.frames.some((f) => f.scan?.confirmation)
    const form = scan.frames.some((f) => (f.scan?.fields ?? 0) > 0)
    const current = job && (confirmed || continuesJob(job, scan.posting, Date.now(), { form })) ? mergePostingInto(job.posting, scan.posting) : scan.posting
    setPosting(current)
    if (job?.loggedAppId && current && job.posting.url === current.url) setLogState({ ok: true, appId: job.loggedAppId })
    setPhase('ready')
    if (current) {
      const c = await runChecks(current, p)
      if (stale()) return
      setChecks(c)
      setResumeId(c.best?.resumeId ?? rs.find((r) => r.isDefault)?.id ?? rs[0]?.id ?? null)
    } else setResumeId(rs.find((r) => r.isDefault)?.id ?? rs[0]?.id ?? null)
  }, [])

  useEffect(() => {
    load()
  }, [load, nonce])

  /** The page's form changed (a new step, or done loading): look again, keeping the job and the fill report. */
  const rescan = useCallback(async (tabId: number) => {
    const frameIds = await ensureInjected(tabId)
    if (!frameIds) return
    const scan = await scanFrames(tabId, frameIds)
    setFrames(scan.frames)
    if (scan.ats !== 'Other') setAts(scan.ats)
    setArmed((await tabState(tabId)).auto)
    // Nothing was readable at first (a page still loading, or its form only now
    // showing): read the job again now that there is something.
    if (!postingRef.current && reread.current !== loadSeq.current && (scan.posting || scan.frames.some((f) => (f.scan?.fields ?? 0) > 0))) {
      reread.current = loadSeq.current
      setNonce((n) => n + 1)
    }
  }, [])

  // Follow the active tab.
  useEffect(() => {
    const onActivated = () => setNonce((n) => n + 1)
    // Sites that swap jobs without loading a page (Handshake, LinkedIn) change
    // the address, and the page then reports the new job: refresh once for both.
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => setNonce((n) => n + 1), ms)
    }
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id !== tab?.id) return
      if (info.status === 'complete') soon(0)
      else if (info.url) soon(1500)
    }
    let scanTimer: ReturnType<typeof setTimeout> | undefined
    const onJob = (msg: { type?: string; tabId?: number }) => {
      if (msg?.tabId !== tab?.id) return
      if (msg?.type === 'tab:job') soon(300)
      if (msg?.type === 'tab:frames' && tab?.id != null) {
        clearTimeout(scanTimer)
        scanTimer = setTimeout(() => void rescan(tab.id!).catch(() => undefined), 300)
      }
    }
    chrome.runtime.onMessage.addListener(onJob)
    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onUpdated.addListener(onUpdated)
    return () => {
      clearTimeout(timer)
      clearTimeout(scanTimer)
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.runtime.onMessage.removeListener(onJob)
    }
  }, [tab?.id, rescan])

  // Live updates from the page (new steps filled, fields edited) and logging.
  useEffect(() => {
    const onMsg = (msg: { type: string; reports?: FieldReport[]; tabId?: number; result?: LogResult; target?: string }, sender: chrome.runtime.MessageSender) => {
      if (msg?.target) return
      if ((msg.type === 'fill:done' || msg.type === 'report:update') && sender.tab?.id === tab?.id && msg.reports) {
        setReports((prev) => mergeReports(prev, msg.reports!, sender.frameId ?? 0))
      }
      if (msg.type === 'logged' && msg.tabId === tab?.id && msg.result) setLogState(msg.result)
    }
    chrome.runtime.onMessage.addListener(onMsg)
    return () => chrome.runtime.onMessage.removeListener(onMsg)
  }, [tab?.id])

  const match = useMemo(() => checks?.matches.find((m) => m.resumeId === resumeId) ?? checks?.best ?? null, [checks, resumeId])
  const verdict = useMemo(() => (checks && posting && profile ? computeVerdict({ posting, profile, matchScore: match?.score ?? null }) : null), [checks, posting, profile, match])

  // Keep the worker's job context current (used for logging and AI drafts).
  useEffect(() => {
    if (!tab?.id || !posting) return
    const tag = resumes.find((r) => r.id === resumeId)?.tag || resumes.find((r) => r.id === resumeId)?.name || ''
    send({
      type: 'job:set',
      tabId: tab.id,
      job: { posting, ats, resumeId, resumeTag: tag, match, verdict, redFlags: checks?.redFlags ?? null, applied: checks?.applied ?? null },
    }).catch(() => undefined)
  }, [tab?.id, posting, ats, resumeId, match, verdict, checks, resumes])

  const [armed, setArmed] = useState(false)
  const [paused, setPaused] = useState(false)
  // Read by a fill already under way, which the state above can't reach.
  const pausedRef = useRef(false)

  /** Stop the fill under way, and the next steps: nothing more is filled until you press Fill. */
  async function pause() {
    if (!tab?.id) return
    pausedRef.current = true
    setPaused(true)
    setArmed(false)
    await send({ type: 'auto:stop', tabId: tab.id }).catch(() => undefined)
  }

  async function fill() {
    if (!tab?.id) return
    pausedRef.current = false
    setPaused(false)
    // On a posting page: fill the application form as soon as "Apply" opens it.
    if (!hasForm) {
      await send({ type: 'auto:arm', tabId: tab.id, resumeId })
      setArmed(true)
      return
    }
    setFilling(true)
    // After this page, the next steps fill as they open (until you pause).
    setArmed(true)
    setError('')
    try {
      const targets = frames.filter((f) => (f as FrameInfo & { scan?: ScanResult | null }).scan?.fields ?? f.fields)
      const list = targets.length ? targets : frames
      let all: FieldReport[] = []
      for (const f of list) {
        if (pausedRef.current) break
        // Never spin forever: what was filled stays filled either way.
        const r = await Promise.race([
          sendToFrame<{ reports: FieldReport[] } | { error: string }>(tab.id, f.frameId, { type: 'fill', resumeId }),
          new Promise<never>((_, no) => setTimeout(() => no(new Error('This page took too long. What was filled stays; press Fill again for the rest.')), FILL_MS)),
        ])
        if (isError(r)) throw new Error(r.error)
        all = all.concat(r.reports.map((x) => ({ ...x, frameId: f.frameId })))
      }
      setReports(all)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // The page moved on (the next step, or a frame reloaded) while filling: not an error.
      if (!/message port closed|Receiving end does not exist|back\/forward cache/i.test(msg)) setError(msg)
    } finally {
      setFilling(false)
    }
  }

  if (phase === 'loading') return <Shell><div className="flex justify-center py-16 text-muted"><Spinner /></div></Shell>
  if (phase === 'locked') return <Shell><Unlock onDone={() => setNonce((n) => n + 1)} /></Shell>
  if (phase === 'setup')
    return (
      <Shell>
        <Card className="p-5">
          <h2 className="text-base font-semibold">Set up your profile</h2>
          <p className="mt-1 text-sm text-muted">Drop in your resume once. Zipply fills every form from it.</p>
          <Button variant="primary" className="mt-4 w-full" onClick={openProfile}>Open Profile</Button>
        </Card>
      </Shell>
    )
  if (phase === 'unsupported')
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <Logo size={44} />
          <div className="text-[15px] font-semibold">Open a job to get started</div>
          <p className="text-sm text-muted">On a posting, Zipply scores your fit. On an application, it fills the form and logs the job when you submit.</p>
        </div>
      </Shell>
    )
  if (phase === 'permission')
    return (
      <Shell>
        <Card className="p-5">
          <h2 className="text-base font-semibold">Allow Zipply on this site</h2>
          <p className="mt-1 text-sm text-muted">Chrome's site access for Zipply is limited on this page. Allow it to read and fill this site.</p>
          <Button
            variant="primary"
            className="mt-4 w-full"
            onClick={async () => {
              const origin = new URL(tab!.url!).origin
              if (await chrome.permissions.request({ origins: [`${origin}/*`] })) setNonce((n) => n + 1)
            }}
          >
            Allow on {tab?.url ? new URL(tab.url).hostname : 'this site'}
          </Button>
        </Card>
      </Shell>
    )

  const hasForm = frames.some((f) => ((f as FrameInfo & { scan?: ScanResult | null }).scan?.fields ?? f.fields) > 0)

  return (
    <Shell>
      <JobHeader title={posting?.title || 'This page'} company={posting?.company || (tab?.url ? new URL(tab.url).hostname : '')} location={posting?.location ?? ''} ats={ats} />

      {checks && verdict && <VerdictCard checks={checks} verdict={verdict} score={checks.thin || !match ? null : match.score} />}

      {checks && match && (
        <MatchCard checks={checks} match={match} resumeId={resumeId} onResume={setResumeId} tabId={tab!.id!} />
      )}
      {posting && !checks?.matches.length && resumes.length === 0 && (
        <Card className="p-4 text-sm text-muted">
          Add a resume on the <button className="text-accent underline" onClick={openProfile}>Profile page</button> to see your match score.
        </Card>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Button variant="primary" size="lg" className="min-w-0 flex-1" onClick={fill} disabled={filling || (!hasForm && (!posting || armed))}>
            {filling ? <><Spinner /> Filling…</> : <><Icon name="bolt" size={16} /><span className="truncate">{hasForm ? 'Fill this page' : armed ? 'Will fill the application' : 'Fill the application when it opens'}</span></>}
          </Button>
          {(filling || armed) && (
            <Button size="lg" className="shrink-0" onClick={pause} title="Stop filling. Nothing more is filled, on this page or the next steps, until you press Fill.">
              <Icon name="pause" size={15} />Pause
            </Button>
          )}
        </div>
        {paused ? (
          <p className="text-center text-xs text-muted" data-testid="paused">Paused. Nothing more is filled until you press Fill.</p>
        ) : !hasForm ? (
          <p className="text-center text-xs text-muted">
            {armed ? 'Click Apply on the page. The form fills as it opens, here or in a new tab.' : posting ? 'No form here yet. Press this, then Apply.' : 'No application form on this page yet.'}
          </p>
        ) : armed && !filling ? (
          <p className="text-center text-xs text-muted">The next steps fill as they open.</p>
        ) : null}
        {error && <p className="text-center text-xs text-bad">{error}</p>}
      </div>

      {reports && <FieldList reports={reports} tabId={tab!.id!} />}

      {posting && <CoverLetter tabId={tab!.id!} />}

      <LogRow tabId={tab!.id!} state={logState} onLogged={setLogState} queue={queue} hasPosting={Boolean(posting)} />

      {hasForm && <CaptureForm tabId={tab!.id!} frames={frames} host={tab?.url ? new URL(tab.url).hostname : 'page'} profile={profile} />}

      <SinceLastTime />
    </Shell>
  )
}

function mergeReports(prev: FieldReport[] | null, next: FieldReport[], frameId: number): FieldReport[] {
  const tagged = next.map((r) => ({ ...r, frameId }))
  if (!prev) return tagged
  const byZid = new Map(prev.map((r) => [`${r.frameId ?? 0}:${r.zid}:${r.label}`, r]))
  for (const r of tagged) byZid.set(`${frameId}:${r.zid}:${r.label}`, r)
  return [...byZid.values()]
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative isolate mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-4">
      {/* A wash of the logo's colors behind the top of the panel. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-44 bg-linear-to-b from-brand-from/12 via-brand-to/5 to-transparent" />
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-bold tracking-tight">
          <Logo size={22} />
          Zipply
        </span>
        <button aria-label="Profile and settings" title="Profile and settings" onClick={openProfile} className="rounded-md p-1 text-muted hover:bg-sunken hover:text-ink">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
        </button>
      </div>
      {children}
    </div>
  )
}

/** The job: a tile with the company's initial, the title, and where it is. */
function JobHeader({ title, company, location, ats }: { title: string; company: string; location: string; ats: ScanResult['ats'] }) {
  const initial = (company.replace(/^(the|www)\b\.?\s*/i, '').match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase()
  return (
    <header className="flex items-start gap-3">
      <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-xl bg-linear-to-br from-brand-from to-brand-to text-lg font-bold text-white shadow-sm shadow-brand-to/25">
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="line-clamp-2 text-base font-semibold leading-snug">{title}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted">
          {company && <span className="max-w-full truncate font-medium text-ink/80">{company}</span>}
          {location && <><span aria-hidden className="text-faint">·</span><span className="max-w-full truncate">{location}</span></>}
          {ats !== 'Other' && <Chip>{ats}</Chip>}
        </div>
      </div>
    </header>
  )
}

function Unlock({ onDone }: { onDone: () => void }) {
  const [pass, setPass] = useState('')
  const [bad, setBad] = useState(false)
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">Unlock Zipply</h2>
      <p className="mt-1 text-sm text-muted">Your profile is encrypted with your passphrase.</p>
      <form
        className="mt-4 flex flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (await unlock(pass)) onDone()
          else setBad(true)
        }}
      >
        <Input type="password" autoFocus value={pass} onChange={(e) => { setPass(e.target.value); setBad(false) }} placeholder="Passphrase" />
        {bad && <p className="text-xs text-bad">That passphrase didn't work.</p>}
        <Button variant="primary" type="submit">Unlock</Button>
      </form>
    </Card>
  )
}

const VERDICT_TONE = { Apply: 'bg-ok/12 text-ok ring-ok/25', Maybe: 'bg-warn/12 text-warn ring-warn/25', Skip: 'bg-bad/12 text-bad ring-bad/25' } as const

/** Should you apply: the match score as a ring, the verdict and why, and anything to watch for. */
function VerdictCard({ checks, verdict, score }: { checks: ChecksResult; verdict: NonNullable<ReturnType<typeof computeVerdict>>; score: number | null }) {
  const [open, setOpen] = useState(false)
  const { applied, redFlags } = checks
  return (
    <Card className="p-4">
      <div className="flex items-center gap-4">
        <ScoreRing score={score} label="match" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className={cx('rounded-full px-2.5 py-0.5 text-sm font-semibold ring-1 ring-inset', VERDICT_TONE[verdict.verdict])}>{verdict.verdict}</span>
            <button className="rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-sunken hover:text-ink" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Hide' : 'Details'}
            </button>
          </div>
          <p className="mt-1.5 text-[13px] leading-snug text-muted">{verdict.reason}</p>
        </div>
      </div>

      {appliedLine(applied) && (
        <p className={cx('mt-3 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-medium', applied.alreadyApplied ? 'bg-bad/10 text-bad' : 'bg-warn/10 text-warn')}>
          <Icon name="flag" /> {appliedLine(applied)!.text}
        </p>
      )}

      {redFlags.flags.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <Label>{redFlags.tier}</Label>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {redFlags.flags.map((f) => (
              <Chip key={f} tone="warn"><Icon name="alert" size={12} />{f}</Chip>
            ))}
          </div>
        </div>
      )}

      {open && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 border-t border-line pt-3 text-[13px]">
          {verdict.dimensions.map((d) => (
            <div key={d.name} className="contents">
              <dt className="flex items-center gap-2 text-muted">
                <Dot tone={d.result === 'pass' ? 'ok' : d.result === 'warn' ? 'warn' : d.result === 'fail' ? 'bad' : 'muted'} />
                {d.name}
              </dt>
              <dd>{d.note}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  )
}

/** How many matched keywords the score card shows (the posting's most important first). */
const TOP_MATCHES = 8

function MatchCard({ checks, match, resumeId, onResume, tabId }: { checks: ChecksResult; match: ChecksResult['matches'][number]; resumeId: string | null; onResume: (id: string) => void; tabId: number }) {
  const [showAts, setShowAts] = useState(false)
  const [tips, setTips] = useState<AiText | null>(null)
  const [busy, setBusy] = useState(false)
  const gradeTone = match.ats.grade === 'Good' ? 'ok' : match.ats.grade === 'Fix' ? 'warn' : 'bad'
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label>Your resume</Label>
          <div className="mt-0.5 truncate text-sm font-medium">{match.tag || match.name}</div>
        </div>
        <button className="shrink-0" onClick={() => setShowAts(!showAts)} aria-expanded={showAts}>
          <Chip tone={gradeTone} title="Can an ATS read this resume?">ATS read: {match.ats.grade}</Chip>
        </button>
      </div>

      {checks.thin && (
        <p className="mt-2 text-xs text-muted" data-testid="thin-posting">
          Not enough of the description to score. Expand it on the page, or paste it under Resumes → Compare.
        </p>
      )}

      {!checks.thin && checks.matches.length > 1 && (
        <div className="mt-3 border-t border-line pt-3">
          <Label className="mb-1.5">Your resumes for this job</Label>
          <ResumeRanking comparison={checks.comparison} selected={resumeId} onSelect={onResume} />
        </div>
      )}

      {showAts && (
        <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-[13px]">
          {match.ats.checks.map((c) => (
            <li key={c.name} className="flex items-start gap-2">
              <span className="mt-1.5"><Dot tone={c.pass === null ? 'muted' : c.pass ? 'ok' : 'bad'} /></span>
              <span><span className="font-medium">{c.name}.</span> <span className="text-muted">{c.reason}</span></span>
            </li>
          ))}
        </ul>
      )}

      {!checks.thin && (match.matched.length > 0 || match.canAdd.length > 0 || match.realGap.length > 0) && (
        <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
          {match.matched.length > 0 && (
            <div data-testid="matched-keywords">
              <Label>Top matches · {match.matched.length} of {match.matched.length + match.canAdd.length + match.realGap.length} keywords</Label>
              <div className="mt-1.5 flex flex-wrap gap-1">{match.matched.slice(0, TOP_MATCHES).map((k) => <Chip key={k} tone="ok"><Icon name="check" size={11} />{k}</Chip>)}</div>
            </div>
          )}
          {match.canAdd.length > 0 && (
            <div>
              <Label>Can add · you have these</Label>
              <div className="mt-1.5 flex flex-wrap gap-1">{match.canAdd.map((k) => <Chip key={k} tone="warn">+ {k}</Chip>)}</div>
            </div>
          )}
          {match.realGap.length > 0 && (
            <div>
              <Label>Real gaps · not in your profile</Label>
              <div className="mt-1.5 flex flex-wrap gap-1">{match.realGap.map((k) => <Chip key={k} dashed>{k}</Chip>)}</div>
            </div>
          )}
        </div>
      )}

      <ul className="mt-3 flex list-disc flex-col gap-1 pl-4 text-[13px] text-muted">
        {match.tips.map((t) => <li key={t}>{t}</li>)}
      </ul>

      {match.canAdd.length > 0 && !tips && (
        <Button size="sm" variant="soft" className="mt-2" disabled={busy} onClick={async () => {
          setBusy(true)
          const r = await send<AiText | { error: string }>({ type: 'ai:tips', tabId })
          setBusy(false)
          setTips(isError(r) ? { text: r.error, warnings: [], model: '' } : r)
        }}>
          {busy ? <Spinner /> : <Icon name="sparkle" />} Suggest bullet rewrites
        </Button>
      )}
      {tips && <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-sunken p-3 font-sans text-[13px]">{tips.text}</pre>}
    </Card>
  )
}

/** A field's state as an icon: filled, to check, or left for you. */
function StatusIcon({ r }: { r: FieldReport }) {
  const [name, tone] = r.missing ? (['alert', 'bg-bad/12 text-bad'] as const) : r.status === 'filled' ? (['check', 'bg-ok/12 text-ok'] as const) : r.status === 'skipped' ? (['minus', 'bg-sunken text-faint'] as const) : (['alert', 'bg-warn/12 text-warn'] as const)
  return (
    <span className={cx('mt-px grid size-5 shrink-0 place-items-center rounded-full', tone)}>
      <Icon name={name} size={11} />
    </span>
  )
}

function FieldList({ reports, tabId }: { reports: FieldReport[]; tabId: number }) {
  const filled = reports.filter((r) => r.status === 'filled').length
  const check = reports.filter((r) => r.status === 'low' || r.status === 'draft').length
  const missing = reports.filter((r) => r.missing).length
  const sorted = [...reports].sort((a, b) => rank(a) - rank(b))
  return (
    <Card>
      <div className="border-b border-line px-4 pt-3 pb-2.5">
        <div className="flex items-center gap-3 text-[13px]">
          <span className="font-semibold">{filled} of {reports.length} filled</span>
          <span className="ml-auto flex items-center gap-1.5 text-muted"><Dot tone="warn" />{check} to check</span>
          {missing > 0 && <span className="flex items-center gap-1.5 text-bad"><Dot tone="bad" />{missing} required</span>}
        </div>
        {/* Filled, then to check, then required and empty; the rest is what's left for you. */}
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
          <span className="bg-ok" style={{ width: `${(filled / Math.max(1, reports.length)) * 100}%` }} />
          <span className="bg-warn" style={{ width: `${(check / Math.max(1, reports.length)) * 100}%` }} />
          <span className="bg-bad" style={{ width: `${(missing / Math.max(1, reports.length)) * 100}%` }} />
        </div>
      </div>
      <ul className="max-h-[50vh] overflow-y-auto py-1">
        {sorted.map((r, i) => (
          <li key={`${r.frameId}:${r.zid}:${i}`} className="flex items-start">
            <button
              disabled={!r.zid}
              onClick={() => r.zid && sendToFrame(tabId, r.frameId ?? 0, { type: 'focus', zid: r.zid }).catch(() => undefined)}
              className="flex min-w-0 flex-1 items-start gap-2.5 px-4 py-1.5 text-left hover:bg-sunken disabled:hover:bg-transparent"
            >
              <StatusIcon r={r} />
              <span className="min-w-0 flex-1">
                <span className={cx('block truncate text-[13px]', r.missing && 'text-bad')}>
                  {r.label}
                  {r.status === 'draft' && <span className="ml-1.5 rounded bg-warn/12 px-1 py-px text-[11px] font-medium text-warn">Draft</span>}
                </span>
                {(r.missing || r.reason || r.warnings?.length) && (
                  <span className="block text-xs text-muted">
                    {r.missing ? 'Required and empty' : r.reason}
                    {r.warnings?.length ? <span className="block text-warn">Not in your profile: {r.warnings.join('; ')}</span> : null}
                  </span>
                )}
              </span>
            </button>
            {r.askAi && r.status === 'skipped' && <AskAi report={r} tabId={tabId} />}
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** Answer one question the fill left: an AI pick for a choice, a draft for a written one. */
function AskAi({ report, tabId }: { report: FieldReport; tabId: number }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  return (
    <div className="flex shrink-0 flex-col items-end px-3 py-1">
      <Button
        size="sm"
        variant="soft"
        className="rounded-full"
        disabled={busy}
        title="Have the AI answer this from your profile and the job. Check it before you submit."
        onClick={async () => {
          setBusy(true)
          setNote('')
          // The answer itself arrives as a report update, like drafts do.
          const r = await sendToFrame<FieldReport | { error: string }>(tabId, report.frameId ?? 0, { type: 'ask', zid: report.zid })
            .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }))
            .finally(() => setBusy(false))
          if (isError(r)) setNote(r.error)
        }}
      >
        {busy ? <><Spinner /> Asking…</> : <><Icon name="sparkle" size={12} />Ask AI</>}
      </Button>
      {note && <span className="max-w-40 text-right text-xs text-bad">{note}</span>}
    </div>
  )
}

function rank(r: FieldReport) {
  if (r.missing) return 0
  if (r.status === 'draft' || r.status === 'low') return 1
  if (r.status === 'skipped') return 2
  return 3
}

function CoverLetter({ tabId }: { tabId: number }) {
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [note, setNote] = useState('')
  if (!text)
    return (
      <Button variant="secondary" disabled={busy} onClick={async () => {
        setBusy(true)
        setNote('')
        const r = await send<AiText | { error: string }>({ type: 'ai:cover', tabId })
          .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }))
          .finally(() => setBusy(false))
        if (isError(r)) setNote(r.error)
        else {
          setText(r.text)
          setWarnings(r.warnings)
        }
      }}>
        {busy ? <><Spinner /> Writing…</> : <><Icon name="pen" />Draft a cover letter</>}
        {note && <span className="text-xs text-bad">{note}</span>}
      </Button>
    )
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">Cover letter <span className="ml-1 text-xs text-warn">Draft</span></span>
        <button className="text-xs text-muted hover:text-ink" onClick={() => setText('')}>Discard</button>
      </div>
      <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={18} />
      {warnings.length > 0 && <p className="mt-2 text-xs text-warn">Check these, they aren't in your profile: {warnings.join('; ')}</p>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => navigator.clipboard.writeText(text).then(() => setNote('Copied'))}>Copy</Button>
        <Button size="sm" onClick={async () => {
          const known = (await tabState(tabId)).frames
          const frames = known.length ? known : [{ frameId: 0 }]
          for (const f of frames) {
            const r = await sendToFrame<{ ok: boolean }>(tabId, f.frameId, { type: 'insert', text, target: 'cover-letter' }).catch(() => null)
            if (r?.ok) return setNote('Inserted')
          }
          setNote('No cover letter box on this page')
        }}>Insert into form</Button>
        {note && <span className="self-center text-xs text-muted">{note}</span>}
      </div>
    </Card>
  )
}

function LogRow({ tabId, state, onLogged, queue, hasPosting }: { tabId: number; state: LogResult | null; onLogged: (r: LogResult) => void; queue: number; hasPosting: boolean }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className={cx('flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-[13px]', state?.ok ? 'border-ok/25 bg-ok/8' : 'border-dashed border-line')}>
      {state?.ok ? (
        <span className="flex items-center gap-2 font-medium text-ok">
          <span className="grid size-5 place-items-center rounded-full bg-ok/15"><Icon name="check" size={12} /></span>
          {state.duplicate ? 'Already in your sheet' : state.queued ? 'Logged, waiting to sync' : 'Logged to your sheet'}
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-2 text-muted">
          <Icon name="sheet" className="text-faint" />
          {state?.error ? <span className="text-bad">{state.error}</span> : 'Logged automatically when you submit'}
        </span>
      )}
      {!state?.ok && hasPosting && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={async () => {
          setBusy(true)
          const r = await send<LogResult>({ type: 'log:manual', tabId })
          setBusy(false)
          onLogged(r)
        }}>
          Log this job
        </Button>
      )}
      {queue > 0 && <span className="text-xs text-warn">{queue} waiting to sync</span>}
    </div>
  )
}

/**
 * Save this page's form, with nothing personal in it, so it can become a test
 * fixture (tests/fixtures/captured). Real forms catch bugs mock ones miss.
 */
function CaptureForm({ tabId, frames, host, profile }: { tabId: number; frames: FrameInfo[]; host: string; profile: Profile | null }) {
  const [note, setNote] = useState('')
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted">
      <span>{note || 'Something filled wrong? Save this form so it can be fixed.'}</span>
      <Button size="sm" variant="ghost" onClick={async () => {
        const target = [...frames].sort((a, b) => ((b as FrameInfo & { scan?: ScanResult | null }).scan?.fields ?? b.fields) - ((a as FrameInfo & { scan?: ScanResult | null }).scan?.fields ?? a.fields))[0]
        const r = await sendToFrame<{ html: string } | { error: string }>(tabId, target?.frameId ?? 0, { type: 'capture' }).catch(() => null)
        if (!r || isError(r)) return setNote("Couldn't read this form.")
        const b = profile?.basics
        const personal = b ? [`${b.firstName} ${b.lastName}`, b.firstName, b.lastName, b.preferredName, b.email, b.phone, b.phone.replace(/\D/g, ''), b.addressLine1, ...Object.values(profile!.links)] : []
        const html = scrubPersonal(r.html, personal.filter((v) => v.length >= 3))
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
        a.download = `zipply-form-${host}-${new Date().toISOString().slice(0, 10)}.html`
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
        setNote('Saved. Nothing you typed is in it. Send it over and it becomes a test.')
      }}>
        Save form
      </Button>
    </div>
  )
}

const SINCE_OPEN = 'zipply-since-open'
/** Older than this, a status change is old news and an unlogged fill is likely abandoned. */
const EVENT_DAYS = 14
const UNLOGGED_DAYS = 7
/** Expanded, each list shows this many. */
const SHOW = 5

function SinceLastTime() {
  const [events, setEvents] = useState<StatusEvent[]>([])
  const [unmatched, setUnmatched] = useState<UnmatchedEmail[]>([])
  const [apps, setApps] = useState<AppliedEntry[]>([])
  const [unlogged, setUnlogged] = useState<UnloggedRow[]>([])
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(SINCE_OPEN) === '1'
    } catch {
      return false
    }
  })

  const refresh = useCallback(async () => {
    const day = 86_400_000
    // One row per job, the latest, even if you filled it more than once.
    const rows = await db.unlogged.where('at').above(Date.now() - UNLOGGED_DAYS * day).reverse().sortBy('at')
    const seen = new Set<string>()
    setUnlogged(rows.filter((u) => {
      const k = `${u.job.posting.company}|${u.job.posting.title}`.toLowerCase()
      return seen.has(k) ? false : (seen.add(k), true)
    }))
    setEvents(await db.events.orderBy('at').reverse().filter((e) => !e.seen && e.at > Date.now() - EVENT_DAYS * day).toArray())
    setUnmatched(await db.unmatched.orderBy('at').reverse().toArray())
    setApps(await db.applied.orderBy('dateApplied').reverse().limit(200).toArray())
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem(SINCE_OPEN, open ? '0' : '1')
    } catch {
      /* private window */
    }
  }

  async function clearAll() {
    await db.events.bulkUpdate(events.map((e) => ({ key: e.id, changes: { seen: true } })))
    await db.unlogged.clear()
    await db.unmatched.bulkDelete(unmatched.map((u) => u.messageId))
    refresh()
  }

  if (!events.length && !unmatched.length && !unlogged.length) return null
  const offers = events.filter((e) => e.kind === 'offer').length
  const conflicts = events.filter((e) => e.kind === 'conflict').length
  const summary = sinceSummary({ offers, conflicts, updates: events.length - offers - conflicts, unlogged: unlogged.length, emails: unmatched.length })
  const more = (n: number) => (n > SHOW ? <li className="text-xs text-muted">and {n - SHOW} more</li> : null)

  return (
    <Card className="p-3">
      <div className="flex items-center gap-2" data-testid="since-last-time">
        <button onClick={toggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Dot tone={offers ? 'ok' : 'accent'} />
          <span className="min-w-0 flex-1 truncate text-[13px]"><span className="font-medium">Since last time:</span> <span className="text-muted">{summary}</span></span>
          <span className="shrink-0 text-xs text-muted">{open ? 'Hide' : 'Show'}</span>
        </button>
        <button className="shrink-0 text-xs text-muted hover:text-ink" onClick={clearAll} title="Mark everything here as seen">Clear all</button>
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-3 border-t border-line pt-2">
          {events.length > 0 && (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {events.slice(0, SHOW).map((e) => (
                <li key={e.id} className="flex items-start gap-2">
                  <span className="mt-1.5"><Dot tone={e.kind === 'offer' ? 'ok' : e.kind === 'conflict' ? 'warn' : e.to === 'Rejected' ? 'muted' : 'accent'} /></span>
                  <span className="min-w-0">
                    <span className="font-medium">{e.company}</span> <span className="text-muted">{e.title}</span>
                    <span className="block text-xs text-muted">{e.kind === 'conflict' ? e.note : `${e.from} → ${e.to}`}{e.kind === 'offer' ? ' · your decision' : ''}</span>
                  </span>
                </li>
              ))}
              {more(events.length)}
            </ul>
          )}
          {unlogged.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-xs text-muted">Filled but not logged</div>
              {unlogged.slice(0, SHOW).map((u) => (
                <div key={u.id} className="flex items-center gap-2 text-[13px]">
                  <span className="mt-0.5"><Dot tone="warn" /></span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{u.job.posting.company || 'Unknown company'}</span> <span className="text-muted">{u.job.posting.title}</span>
                  </span>
                  <Button size="sm" onClick={async () => { await send({ type: 'log:unlogged', id: u.id }); refresh() }}>Log it</Button>
                  <Button size="sm" variant="ghost" title="I didn't submit this one" onClick={async () => {
                    // Dismiss every copy of this job, not just the latest.
                    const k = `${u.job.posting.company}|${u.job.posting.title}`.toLowerCase()
                    await db.unlogged.filter((r) => `${r.job.posting.company}|${r.job.posting.title}`.toLowerCase() === k).delete()
                    refresh()
                  }}>✕</Button>
                </div>
              ))}
              {unlogged.length > SHOW && <div className="text-xs text-muted">and {unlogged.length - SHOW} more</div>}
            </div>
          )}
          {unmatched.length > 0 && (
            <div>
              <div className="text-xs text-muted">Emails to sort</div>
              <ul className="mt-1 flex flex-col gap-2">
                {unmatched.slice(0, SHOW).map((u) => <Unmatched key={u.messageId} u={u} apps={apps} onDone={refresh} />)}
                {more(unmatched.length)}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function Unmatched({ u, apps, onDone }: { u: UnmatchedEmail; apps: AppliedEntry[]; onDone: () => void }) {
  const [meta, setMeta] = useState<{ from: string; subject: string; date: string } | null>(null)
  const [appId, setAppId] = useState(u.candidates[0] ?? '')
  const [status, setStatus] = useState('Received')
  useEffect(() => {
    send<{ from: string; subject: string; date: string } | { error: string }>({ type: 'gmail:message', messageId: u.messageId }).then((r) => !isError(r) && setMeta(r)).catch(() => undefined)
  }, [u.messageId])
  const options = u.candidates.length ? apps.filter((a) => u.candidates.includes(a.appId)) : apps
  return (
    <li className="rounded-lg border border-line p-2.5 text-[13px]">
      <div className="truncate font-medium">{meta?.subject ?? 'Loading…'}</div>
      <div className="truncate text-xs text-muted">{meta ? `${meta.from} · ${meta.date}` : ''} · {u.reason}</div>
      <div className="mt-2 flex gap-1.5">
        <Select value={appId} onChange={(e) => setAppId(e.target.value)} className="h-7 flex-1 text-xs">
          <option value="">Application…</option>
          {options.map((a) => <option key={a.appId} value={a.appId}>{a.company}: {a.title}</option>)}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-7 w-28 text-xs">
          {['Received', 'Assessment', 'Interview', 'Offer', 'Rejected'].map((s) => <option key={s}>{s}</option>)}
        </Select>
        <Button size="sm" disabled={!appId} onClick={async () => {
          await send({ type: 'status:assign', messageId: u.messageId, appId, status })
          onDone()
        }}>Set</Button>
        <Button size="sm" variant="ghost" onClick={async () => { await db.unmatched.delete(u.messageId); onDone() }} title="Ignore this email">✕</Button>
      </div>
    </li>
  )
}

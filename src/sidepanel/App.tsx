import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppliedEntry, FieldReport, Posting, Profile, ResumeMeta, Settings, StatusEvent, UnmatchedEmail } from '@/shared/types'
import type { AiText, FrameInfo, JobContext, LogResult, ScanResult } from '@/shared/messages'
import { isError, send, sendToFrame } from '@/shared/messages'
import { computeVerdict } from '@/core/score/verdict'
import { getProfile, listResumes } from '@/lib/repo'
import { isLocked, unlock } from '@/lib/keys'
import { runChecks, type ChecksResult } from '@/lib/checks'
import { db } from '@/lib/db'
import { Button, Card, Chip, Dot, Empty, Input, Select, Spinner, TextArea, cx } from '@/ui/kit'
import contentScript from '@/content/index.ts?script'

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

async function tabState(tabId: number) {
  return send<{ frames: FrameInfo[]; job: JobContext | null; queue: number; settings: Settings }>({ type: 'tab:state', tabId })
}

/** Inject the content script on sites without an adapter (activeTab or a granted origin). */
async function ensureInjected(tabId: number): Promise<boolean> {
  const { frames } = await tabState(tabId)
  if (frames.length) return true
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [contentScript] })
    await new Promise((r) => setTimeout(r, 400))
    return true
  } catch {
    return false
  }
}

async function scanFrames(tabId: number): Promise<{ frames: (FrameInfo & { scan: ScanResult | null })[]; posting: Posting | null; ats: ScanResult['ats'] }> {
  let { frames } = await tabState(tabId)
  if (!frames.length) frames = [{ frameId: 0, ats: 'Other', fields: 0, confirmation: false, url: '' }]
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

  const load = useCallback(async () => {
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
    if (!t?.id || !/^https?:/.test(t.url ?? '')) return setPhase('unsupported')
    if (!(await ensureInjected(t.id))) return setPhase('permission')
    const scan = await scanFrames(t.id)
    setFrames(scan.frames)
    setAts(scan.ats)
    setPosting(scan.posting)
    const state = await tabState(t.id)
    setQueue(state.queue)
    if (state.job?.loggedAppId && scan.posting && state.job.posting.url === scan.posting.url) setLogState({ ok: true, appId: state.job.loggedAppId })
    setPhase('ready')
    if (scan.posting) {
      const c = await runChecks(scan.posting, p)
      setChecks(c)
      setResumeId(c.best?.resumeId ?? rs.find((r) => r.isDefault)?.id ?? rs[0]?.id ?? null)
    } else setResumeId(rs.find((r) => r.isDefault)?.id ?? rs[0]?.id ?? null)
  }, [])

  useEffect(() => {
    load()
  }, [load, nonce])

  // Follow the active tab.
  useEffect(() => {
    const onActivated = () => setNonce((n) => n + 1)
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tab?.id && info.status === 'complete') setNonce((n) => n + 1)
    }
    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onUpdated.addListener(onUpdated)
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    }
  }, [tab?.id])

  // Live updates from the page (new steps filled, fields edited) and logging.
  useEffect(() => {
    const onMsg = (msg: { type: string; reports?: FieldReport[]; tabId?: number; result?: LogResult; target?: string }, sender: chrome.runtime.MessageSender) => {
      if (msg?.target) return
      if (msg.type === 'fill:done' && sender.tab?.id === tab?.id && msg.reports) {
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

  async function fill() {
    if (!tab?.id) return
    setFilling(true)
    setError('')
    try {
      const targets = frames.filter((f) => (f as FrameInfo & { scan?: ScanResult | null }).scan?.fields ?? f.fields)
      const list = targets.length ? targets : frames
      let all: FieldReport[] = []
      for (const f of list) {
        const r = await sendToFrame<{ reports: FieldReport[] } | { error: string }>(tab.id, f.frameId, { type: 'fill', resumeId })
        if (isError(r)) throw new Error(r.error)
        all = all.concat(r.reports.map((x) => ({ ...x, frameId: f.frameId })))
      }
      setReports(all)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
        <Empty>Open a job application to get started.</Empty>
      </Shell>
    )
  if (phase === 'permission')
    return (
      <Shell>
        <Card className="p-5">
          <h2 className="text-base font-semibold">Allow Zipply on this site</h2>
          <p className="mt-1 text-sm text-muted">This form isn't on a site Zipply knows. Allow it to read and fill this page.</p>
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
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{posting?.title || 'This page'}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[13px] text-muted">
            <span className="truncate">{posting?.company || tab?.url && new URL(tab.url).hostname}</span>
            {ats !== 'Other' && <Chip>{ats}</Chip>}
          </div>
        </div>
      </header>

      {checks && verdict && <VerdictCard checks={checks} verdict={verdict} />}

      {checks && match && (
        <MatchCard checks={checks} match={match} resumeId={resumeId} onResume={setResumeId} tabId={tab!.id!} />
      )}
      {posting && !checks?.matches.length && resumes.length === 0 && (
        <Card className="p-4 text-sm text-muted">
          Add a resume on the <button className="text-accent underline" onClick={openProfile}>Profile page</button> to see your match score.
        </Card>
      )}

      <div className="flex flex-col gap-2">
        <Button variant="primary" size="lg" onClick={fill} disabled={filling || !hasForm}>
          {filling ? <><Spinner /> Filling…</> : 'Fill this page'}
        </Button>
        {!hasForm && <p className="text-center text-xs text-muted">No application form on this page yet.</p>}
        {error && <p className="text-center text-xs text-bad">{error}</p>}
      </div>

      {reports && <FieldList reports={reports} tabId={tab!.id!} />}

      {posting && <CoverLetter tabId={tab!.id!} />}

      <LogRow tabId={tab!.id!} state={logState} onLogged={setLogState} queue={queue} hasPosting={Boolean(posting)} />

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
    <div className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold tracking-tight text-muted">Zipply</span>
        <button aria-label="Profile and settings" title="Profile and settings" onClick={openProfile} className="rounded-md p-1 text-muted hover:bg-sunken hover:text-ink">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
        </button>
      </div>
      {children}
    </div>
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

const VERDICT_TONE = { Apply: 'text-ok', Maybe: 'text-warn', Skip: 'text-bad' } as const

function VerdictCard({ checks, verdict }: { checks: ChecksResult; verdict: NonNullable<ReturnType<typeof computeVerdict>> }) {
  const [open, setOpen] = useState(false)
  const { applied, redFlags } = checks
  return (
    <Card className="p-4">
      <button className="flex w-full items-baseline justify-between gap-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={cx('text-xl font-semibold', VERDICT_TONE[verdict.verdict])}>{verdict.verdict}</span>
        <span className="text-xs text-muted">{open ? 'Hide' : 'Details'}</span>
      </button>
      <p className="mt-0.5 text-sm text-muted">{verdict.reason}</p>

      {applied.alreadyApplied && (
        <p className="mt-3 flex items-center gap-2 text-sm text-bad">
          <Dot tone="bad" /> You applied on {applied.alreadyApplied.dateApplied} ({applied.alreadyApplied.status})
        </p>
      )}
      {applied.possiblyApplied && (
        <p className="mt-3 flex items-center gap-2 text-sm text-warn">
          <Dot tone="warn" /> Possibly applied: “{applied.possiblyApplied.title}” on {applied.possiblyApplied.dateApplied}
        </p>
      )}

      {redFlags.flags.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="text-xs font-medium text-muted">{redFlags.tier}</div>
          <ul className="mt-1 flex flex-col gap-1">
            {redFlags.flags.map((f) => (
              <li key={f} className="flex items-center gap-2 text-[13px] text-warn"><Dot tone="warn" />{f}</li>
            ))}
          </ul>
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

function MatchCard({ checks, match, resumeId, onResume, tabId }: { checks: ChecksResult; match: ChecksResult['matches'][number]; resumeId: string | null; onResume: (id: string) => void; tabId: number }) {
  const [showAts, setShowAts] = useState(false)
  const [tips, setTips] = useState<AiText | null>(null)
  const [busy, setBusy] = useState(false)
  const gradeTone = match.ats.grade === 'Good' ? 'ok' : match.ats.grade === 'Fix' ? 'warn' : 'bad'
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs text-muted">Match score</div>
          <div className="text-2xl font-semibold tabular-nums">{match.score}</div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-end gap-1.5">
          {checks.matches.length > 1 ? (
            <Select value={resumeId ?? ''} onChange={(e) => onResume(e.target.value)} className="max-w-48">
              {checks.matches.map((m) => (
                <option key={m.resumeId} value={m.resumeId}>{(m.tag || m.name)} · {m.score}</option>
              ))}
            </Select>
          ) : (
            <span className="truncate text-[13px] text-muted">{match.tag || match.name}</span>
          )}
          <button onClick={() => setShowAts(!showAts)} aria-expanded={showAts}>
            <Chip tone={gradeTone} title="Can an ATS read this resume?">ATS read: {match.ats.grade}</Chip>
          </button>
        </div>
      </div>

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

      {(match.canAdd.length > 0 || match.realGap.length > 0) && (
        <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
          {match.canAdd.length > 0 && (
            <div>
              <div className="text-xs text-muted">Can add (you have these)</div>
              <div className="mt-1 flex flex-wrap gap-1">{match.canAdd.map((k) => <Chip key={k} tone="warn">{k}</Chip>)}</div>
            </div>
          )}
          {match.realGap.length > 0 && (
            <div>
              <div className="text-xs text-muted">Real gaps (not in your profile)</div>
              <div className="mt-1 flex flex-wrap gap-1">{match.realGap.map((k) => <Chip key={k}>{k}</Chip>)}</div>
            </div>
          )}
        </div>
      )}

      <ul className="mt-3 flex list-disc flex-col gap-1 pl-4 text-[13px] text-muted">
        {match.tips.map((t) => <li key={t}>{t}</li>)}
      </ul>

      {match.canAdd.length > 0 && !tips && (
        <Button size="sm" variant="ghost" className="mt-2" disabled={busy} onClick={async () => {
          setBusy(true)
          const r = await send<AiText | { error: string }>({ type: 'ai:tips', tabId })
          setBusy(false)
          setTips(isError(r) ? { text: r.error, warnings: [], model: '' } : r)
        }}>
          {busy ? <Spinner /> : null} Suggest bullet rewrites
        </Button>
      )}
      {tips && <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-sunken p-3 font-sans text-[13px]">{tips.text}</pre>}
    </Card>
  )
}

const STATUS_DOT = { filled: 'ok', low: 'warn', draft: 'warn', skipped: 'muted' } as const

function FieldList({ reports, tabId }: { reports: FieldReport[]; tabId: number }) {
  const filled = reports.filter((r) => r.status === 'filled').length
  const check = reports.filter((r) => r.status === 'low' || r.status === 'draft').length
  const missing = reports.filter((r) => r.missing).length
  const sorted = [...reports].sort((a, b) => rank(a) - rank(b))
  return (
    <Card>
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-[13px]">
        <span className="flex items-center gap-1.5"><Dot tone="ok" />{filled} filled</span>
        <span className="flex items-center gap-1.5"><Dot tone="warn" />{check} to check</span>
        {missing > 0 && <span className="flex items-center gap-1.5 text-bad"><Dot tone="bad" />{missing} required</span>}
      </div>
      <ul className="max-h-[50vh] overflow-y-auto py-1">
        {sorted.map((r, i) => (
          <li key={`${r.frameId}:${r.zid}:${i}`}>
            <button
              disabled={!r.zid}
              onClick={() => r.zid && sendToFrame(tabId, r.frameId ?? 0, { type: 'focus', zid: r.zid }).catch(() => undefined)}
              className="flex w-full items-start gap-2.5 px-4 py-1.5 text-left hover:bg-sunken disabled:hover:bg-transparent"
            >
              <span className="mt-1.5"><Dot tone={r.missing ? 'bad' : STATUS_DOT[r.status]} /></span>
              <span className="min-w-0 flex-1">
                <span className={cx('block truncate text-[13px]', r.missing && 'text-bad')}>
                  {r.label}
                  {r.status === 'draft' && <span className="ml-1.5 text-xs text-warn">Draft</span>}
                </span>
                {(r.missing || r.reason || r.warnings?.length) && (
                  <span className="block text-xs text-muted">
                    {r.missing ? 'Required and empty' : r.reason}
                    {r.warnings?.length ? <span className="block text-warn">Not in your profile: {r.warnings.join('; ')}</span> : null}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
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
        setBusy(false)
        if (isError(r)) setNote(r.error)
        else {
          setText(r.text)
          setWarnings(r.warnings)
        }
      }}>
        {busy ? <><Spinner /> Writing…</> : 'Draft a cover letter'}
        {note && <span className="text-xs text-bad">{note}</span>}
      </Button>
    )
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">Cover letter <span className="ml-1 text-xs text-warn">Draft</span></span>
        <button className="text-xs text-muted hover:text-ink" onClick={() => setText('')}>Discard</button>
      </div>
      <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={10} />
      {warnings.length > 0 && <p className="mt-2 text-xs text-warn">Check these, they aren't in your profile: {warnings.join('; ')}</p>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => navigator.clipboard.writeText(text).then(() => setNote('Copied'))}>Copy</Button>
        <Button size="sm" onClick={async () => {
          const frames = (await tabState(tabId)).frames
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
    <div className="flex items-center justify-between gap-3 text-[13px]">
      {state?.ok ? (
        <span className="flex items-center gap-2 text-muted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="text-ok"><path d="M20 6 9 17l-5-5" /></svg>
          {state.duplicate ? 'Already in your sheet' : state.queued ? 'Logged, waiting to sync' : 'Logged to your sheet'}
        </span>
      ) : (
        <span className="text-muted">{state?.error ? <span className="text-bad">{state.error}</span> : 'Logged automatically when you submit'}</span>
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

function SinceLastTime() {
  const [events, setEvents] = useState<StatusEvent[]>([])
  const [unmatched, setUnmatched] = useState<UnmatchedEmail[]>([])
  const [apps, setApps] = useState<AppliedEntry[]>([])

  const refresh = useCallback(async () => {
    setEvents(await db.events.orderBy('at').reverse().filter((e) => !e.seen).limit(20).toArray())
    setUnmatched(await db.unmatched.orderBy('at').reverse().limit(10).toArray())
    setApps(await db.applied.orderBy('dateApplied').reverse().limit(200).toArray())
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!events.length && !unmatched.length) return null
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Since last time</h3>
        {events.length > 0 && (
          <button className="text-xs text-muted hover:text-ink" onClick={async () => {
            await db.events.bulkUpdate(events.map((e) => ({ key: e.id, changes: { seen: true } })))
            refresh()
          }}>Clear</button>
        )}
      </div>
      <ul className="mt-2 flex flex-col gap-1.5 text-[13px]">
        {events.map((e) => (
          <li key={e.id} className="flex items-start gap-2">
            <span className="mt-1.5"><Dot tone={e.kind === 'offer' ? 'ok' : e.kind === 'conflict' ? 'warn' : e.to === 'Rejected' ? 'muted' : 'accent'} /></span>
            <span>
              <span className="font-medium">{e.company}</span> <span className="text-muted">{e.title}</span>
              <span className="block text-xs text-muted">{e.kind === 'conflict' ? e.note : `${e.from} → ${e.to}`}{e.kind === 'offer' ? ' · your decision' : ''}</span>
            </span>
          </li>
        ))}
      </ul>
      {unmatched.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="text-xs text-muted">Emails to assign</div>
          <ul className="mt-1 flex flex-col gap-2">
            {unmatched.map((u) => <Unmatched key={u.messageId} u={u} apps={apps} onDone={refresh} />)}
          </ul>
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

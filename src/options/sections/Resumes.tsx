import { useCallback, useEffect, useState } from 'react'
import type { AtsReport, ResumeMeta } from '@/shared/types'
import { atsReport } from '@/core/score/atsCheck'
import { deleteResume, getResume, listResumes, MAX_RESUMES, saveResume, updateResumeMeta } from '@/lib/repo'
import { ACCEPT, readResumeFile } from '@/lib/resumeFile'
import { compareDescription } from '@/lib/checks'
import { getProfile } from '@/lib/repo'
import { Button, Chip, Dot, Empty, Input, Spinner, TextArea } from '@/ui/kit'
import { ResumeRanking } from '@/ui/ResumeRanking'
import { Section } from '../App'

export function Resumes() {
  const [list, setList] = useState<(ResumeMeta & { ats: AtsReport })[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const metas = await listResumes()
    const out = []
    for (const m of metas) {
      const r = await getResume(m.id)
      if (r) out.push({ ...m, ats: atsReport(r.content) })
    }
    setList(out)
  }, [])

  useEffect(() => {
    refresh()
    window.addEventListener('zipply:resumes', refresh)
    return () => window.removeEventListener('zipply:resumes', refresh)
  }, [refresh])

  async function add(file: File) {
    setBusy(true)
    setError('')
    try {
      const { content, data, mime } = await readResumeFile(file)
      await saveResume({ name: file.name, tag: '', mime, size: file.size, content, data })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section id="resumes" title="Resumes" intro={`Keep up to ${MAX_RESUMES} versions, each with a tag like “Data” or “Full-stack”. The best match is picked for each job.`}>
      {list.length === 0 && <Empty>No resumes yet. Drop one in at the top of the page.</Empty>}
      <ul className="flex flex-col divide-y divide-line">
        {list.map((r) => {
          const tone = r.ats.grade === 'Good' ? 'ok' : r.ats.grade === 'Fix' ? 'warn' : 'bad'
          return (
            <li key={r.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{r.name}</div>
                  <div className="text-xs text-muted">{Math.round(r.size / 1024)} KB · added {new Date(r.addedAt).toLocaleDateString()}</div>
                </div>
                <Input className="w-36" placeholder="Tag" value={r.tag} onChange={(e) => { const tag = e.target.value; setList((l) => l.map((x) => (x.id === r.id ? { ...x, tag } : x))); updateResumeMeta(r.id, { tag }) }} />
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input type="radio" name="default-resume" checked={r.isDefault} onChange={async () => { await updateResumeMeta(r.id, { isDefault: true }); refresh() }} />
                  Default
                </label>
                <button onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                  <Chip tone={tone}>ATS read: {r.ats.grade}</Chip>
                </button>
                <Button size="sm" variant="danger" onClick={async () => { await deleteResume(r.id); refresh() }}>Delete</Button>
              </div>
              {open === r.id && (
                <ul className="mt-3 flex flex-col gap-1 rounded-lg bg-sunken p-3 text-[13px]">
                  {r.ats.checks.map((c) => (
                    <li key={c.name} className="flex items-start gap-2">
                      <span className="mt-1.5"><Dot tone={c.pass === null ? 'muted' : c.pass ? 'ok' : 'bad'} /></span>
                      <span><span className="font-medium">{c.name}.</span> <span className="text-muted">{c.reason}</span></span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
      {list.length < MAX_RESUMES && (
        <label className="mt-4 inline-flex cursor-pointer">
          <input type="file" accept={ACCEPT} className="sr-only" onChange={(e) => e.target.files?.[0] && add(e.target.files[0])} />
          <span className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3.5 text-sm font-medium hover:bg-sunken">
            {busy ? <Spinner /> : null} Add a resume
          </span>
        </label>
      )}
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      {list.length > 0 && <CompareJob count={list.length} />}
    </Section>
  )
}

/** Paste any job description and see every resume scored against it. */
function CompareJob({ count }: { count: number }) {
  const [text, setText] = useState('')
  const [result, setResult] = useState<Awaited<ReturnType<typeof compareDescription>> | null>(null)
  const [busy, setBusy] = useState(false)
  const short = text.trim().length < 80
  const best = result?.matches[0]

  async function run() {
    setBusy(true)
    try {
      setResult(await compareDescription(text, await getProfile()))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 border-t border-line pt-4">
      <div className="text-sm font-medium">Compare against a job description</div>
      <p className="mt-0.5 text-xs text-muted">
        Paste a posting from anywhere (an email, a PDF, a careers page) to see which {count > 1 ? 'resume fits it best' : 'parts of your resume fit it'}. Nothing leaves your browser.
      </p>
      <TextArea className="mt-2 min-h-28" placeholder="Paste the job description" value={text} onChange={(e) => { setText(e.target.value); setResult(null) }} />
      <div className="mt-2 flex items-center gap-3">
        <Button size="sm" variant="primary" disabled={short || busy} onClick={run}>{busy ? <Spinner /> : null} Compare {count > 1 ? 'resumes' : ''}</Button>
        {short && text.trim() && <span className="text-xs text-muted">Paste the full description, not just the title.</span>}
      </div>
      {result && best && (
        <div className="mt-4 flex flex-col gap-3">
          <ResumeRanking comparison={result.comparison} />
          {(best.canAdd.length > 0 || best.realGap.length > 0) && (
            <div className="flex flex-col gap-2 rounded-lg bg-sunken p-3">
              <div className="text-xs font-medium">For {best.tag || best.name}</div>
              {best.canAdd.length > 0 && (
                <div>
                  <div className="text-xs text-muted">Can add (you have these)</div>
                  <div className="mt-1 flex flex-wrap gap-1">{best.canAdd.map((k) => <Chip key={k} tone="warn">{k}</Chip>)}</div>
                </div>
              )}
              {best.realGap.length > 0 && (
                <div>
                  <div className="text-xs text-muted">Real gaps (not in your profile)</div>
                  <div className="mt-1 flex flex-wrap gap-1">{best.realGap.map((k) => <Chip key={k}>{k}</Chip>)}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

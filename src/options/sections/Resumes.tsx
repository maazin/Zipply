import { useCallback, useEffect, useState } from 'react'
import type { AtsReport, ResumeMeta } from '@/shared/types'
import { atsReport } from '@/core/score/atsCheck'
import { deleteResume, getResume, listResumes, MAX_RESUMES, saveResume, updateResumeMeta } from '@/lib/repo'
import { ACCEPT, readResumeFile } from '@/lib/resumeFile'
import { Button, Chip, Dot, Empty, Input, Spinner } from '@/ui/kit'
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
    </Section>
  )
}

import { useState } from 'react'
import type { EducationEntry, Profile, WorkEntry } from '@/shared/types'
import { uid } from '@/shared/defaults'
import { parseResume, parseDate, type ParsedResume } from '@/core/resume/parse'
import { resumeStructurePrompt } from '@/core/ai/prompts'
import { readResumeFile, ACCEPT } from '@/lib/resumeFile'
import { nanoPrompt, nanoStatus } from '@/lib/nano'
import { bumpUsage } from '@/lib/usage'
import { listResumes, saveResume, MAX_RESUMES } from '@/lib/repo'
import { Button, Card, Chip, Spinner, cx } from '@/ui/kit'
import type { Update } from '../App'

interface NanoResume {
  firstName: string
  lastName: string
  email: string
  phone: string
  city: string
  state: string
  headline: string
  summary: string
  linkedin: string
  github: string
  portfolio: string
  skills: string[]
  work: { title: string; company: string; location?: string; start?: string; end?: string; current?: boolean; description?: string }[]
  education: { school: string; degree?: string; major?: string; start?: string; end?: string; gpa?: string }[]
}

const ym = (s = '') => (/^\d{4}(-\d{2})?$/.test(s) ? s : parseDate(s))

/** Gemini Nano (on device) turns the rule-split text into structured fields, when this laptop can run it. */
async function structureWithNano(text: string): Promise<ParsedResume | null> {
  if ((await nanoStatus()) !== 'available') return null
  const { system, prompt, schema } = resumeStructurePrompt(text)
  try {
    const out = await nanoPrompt(system, prompt, schema)
    if (!out) return null
    await bumpUsage('gemini-nano')
    const r = JSON.parse(out) as NanoResume
    return {
      basics: { firstName: r.firstName, lastName: r.lastName, email: r.email, phone: r.phone, city: r.city, state: r.state, headline: r.headline, summary: r.summary },
      links: { linkedin: r.linkedin, github: r.github, portfolio: r.portfolio },
      work: (r.work ?? []).map((w): WorkEntry => ({ id: uid(), title: w.title, company: w.company, location: w.location ?? '', start: ym(w.start), end: w.current ? '' : ym(w.end), current: Boolean(w.current) || /present/i.test(w.end ?? ''), description: w.description ?? '' })),
      education: (r.education ?? []).map((e): EducationEntry => ({ id: uid(), school: e.school, degree: e.degree ?? '', major: e.major ?? '', start: ym(e.start), end: ym(e.end), gpa: e.gpa ?? '' })),
      skills: r.skills ?? [],
    }
  } catch {
    return null
  }
}

/** Rules first; Nano fills in what the rules missed. */
function combine(rules: ParsedResume, nano: ParsedResume | null): ParsedResume {
  if (!nano) return rules
  const pick = <T extends object>(a: T, b: T) => Object.fromEntries(Object.keys({ ...a, ...b }).map((k) => [k, (b as Record<string, unknown>)[k] || (a as Record<string, unknown>)[k] || ''])) as T
  return {
    basics: pick(rules.basics, nano.basics),
    links: pick(rules.links, nano.links),
    work: nano.work.length >= rules.work.length ? nano.work : rules.work,
    education: nano.education.length >= rules.education.length ? nano.education : rules.education,
    skills: [...new Set([...rules.skills, ...nano.skills])],
  }
}

const LABELS: Record<string, string> = {
  firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone', city: 'City', state: 'State',
  headline: 'Headline', summary: 'Summary', linkedin: 'LinkedIn', github: 'GitHub', portfolio: 'Website',
}

type Picks = { basics: Record<string, boolean>; links: Record<string, boolean>; work: boolean[]; education: boolean[]; skills: boolean }

export function ResumeDrop({ profile, update }: { profile: Profile; update: Update }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [parsed, setParsed] = useState<{ data: ParsedResume; usedNano: boolean } | null>(null)
  const [picks, setPicks] = useState<Picks | null>(null)
  const [over, setOver] = useState(false)

  async function handle(file: File) {
    setError('')
    try {
      setBusy('Reading your resume…')
      const { content, data, mime } = await readResumeFile(file)
      if ((await listResumes()).length < MAX_RESUMES) {
        await saveResume({ name: file.name, tag: '', mime, size: file.size, content, data })
        window.dispatchEvent(new Event('zipply:resumes'))
      }
      const rules = parseResume(content.text)
      setBusy('Structuring fields on this device…')
      const nano = await structureWithNano(content.text)
      const data2 = combine(rules, nano)
      setParsed({ data: data2, usedNano: Boolean(nano) })
      // Default: take a value when your profile doesn't have one yet.
      const b = profile.basics as unknown as Record<string, string>
      const l = profile.links as unknown as Record<string, string>
      setPicks({
        basics: Object.fromEntries(Object.entries(data2.basics).map(([k, v]) => [k, Boolean(v) && !b[k]])),
        links: Object.fromEntries(Object.entries(data2.links).map(([k, v]) => [k, Boolean(v) && !l[k]])),
        work: data2.work.map(() => profile.work.length === 0),
        education: data2.education.map(() => profile.education.length === 0),
        skills: true,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  function apply() {
    if (!parsed || !picks) return
    const d = parsed.data
    update((p) => ({
      ...p,
      basics: { ...p.basics, ...Object.fromEntries(Object.entries(d.basics).filter(([k]) => picks.basics[k])) },
      links: { ...p.links, ...Object.fromEntries(Object.entries(d.links).filter(([k]) => picks.links[k])) },
      work: [...p.work, ...d.work.filter((_, i) => picks.work[i])],
      education: [...p.education, ...d.education.filter((_, i) => picks.education[i])],
      skills: picks.skills ? [...new Set([...p.skills, ...d.skills])] : p.skills,
    }))
    setParsed(null)
    setPicks(null)
  }

  if (parsed && picks) {
    const d = parsed.data
    const toggle = (path: keyof Picks, key: string | number) =>
      setPicks((pk) => {
        if (!pk) return pk
        const cur = pk[path]
        if (Array.isArray(cur)) return { ...pk, [path]: cur.map((v, i) => (i === key ? !v : v)) }
        if (typeof cur === 'object') return { ...pk, [path]: { ...cur, [key]: !cur[key as string] } }
        return { ...pk, [path]: !cur }
      })
    return (
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Check what we found</h2>
          {parsed.usedNano && <Chip>Structured on this device</Chip>}
        </div>
        <p className="mt-1 text-sm text-muted">Tick what to copy into your profile. You can edit everything afterwards.</p>
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          <Group title="Contact">
            {Object.entries(d.basics).filter(([, v]) => v).map(([k, v]) => (
              <Check key={k} checked={picks.basics[k]} onChange={() => toggle('basics', k)} label={LABELS[k] ?? k} value={String(v)} />
            ))}
            {Object.entries(d.links).filter(([, v]) => v).map(([k, v]) => (
              <Check key={k} checked={picks.links[k]} onChange={() => toggle('links', k)} label={LABELS[k] ?? k} value={String(v)} />
            ))}
          </Group>
          <Group title={`Experience (${d.work.length})`}>
            {d.work.map((w, i) => (
              <Check key={w.id} checked={picks.work[i]} onChange={() => toggle('work', i)} label={`${w.title || 'Untitled'}`} value={`${w.company} · ${w.start || '?'} to ${w.current ? 'present' : w.end || '?'}`} />
            ))}
          </Group>
          <Group title={`Education (${d.education.length})`}>
            {d.education.map((e, i) => (
              <Check key={e.id} checked={picks.education[i]} onChange={() => toggle('education', i)} label={e.school || 'School'} value={[e.degree, e.major, e.end].filter(Boolean).join(' · ')} />
            ))}
          </Group>
          <Group title={`Skills (${d.skills.length})`}>
            <Check checked={picks.skills} onChange={() => toggle('skills', 0)} label="Add skills" value={d.skills.join(', ')} />
          </Group>
        </div>
        <div className="mt-5 flex gap-2">
          <Button variant="primary" onClick={apply}>Copy to profile</Button>
          <Button variant="ghost" onClick={() => { setParsed(null); setPicks(null) }}>Cancel</Button>
        </div>
      </Card>
    )
  }

  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const f = e.dataTransfer.files[0]
        if (f) handle(f)
      }}
      className={cx('flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-6 py-8 text-center transition-colors', over ? 'border-accent bg-surface' : 'border-line hover:bg-surface')}
    >
      <input type="file" accept={ACCEPT} className="sr-only" onChange={(e) => e.target.files?.[0] && handle(e.target.files[0])} />
      {busy ? (
        <span className="flex items-center gap-2 text-sm text-muted"><Spinner /> {busy}</span>
      ) : (
        <>
          <span className="text-sm font-medium">Drop your resume here</span>
          <span className="text-xs text-muted">PDF or Word. Fields fill themselves; you check them before anything is saved.</span>
        </>
      )}
      {error && <span className="text-xs text-bad">{error}</span>}
    </label>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-[13px] font-medium text-muted">{title}</h3>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  )
}

function Check({ checked, onChange, label, value }: { checked: boolean; onChange: () => void; label: string; value: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={onChange} className="mt-1 accent-[var(--color-accent)]" />
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        <span className="block truncate text-xs text-muted">{value}</span>
      </span>
    </label>
  )
}

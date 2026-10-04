import { useCallback, useEffect, useRef, useState } from 'react'
import type { Profile } from '@/shared/types'
import { getProfile, saveProfile } from '@/lib/repo'
import { isLocked, unlock } from '@/lib/keys'
import { Button, Card, Input, Spinner, cx } from '@/ui/kit'
import { ResumeDrop } from './sections/ResumeDrop'
import { Basics } from './sections/Basics'
import { Experience } from './sections/Experience'
import { Education } from './sections/Education'
import { SkillsLinks } from './sections/SkillsLinks'
import { Resumes } from './sections/Resumes'
import { StandardAnswers } from './sections/StandardAnswers'
import { AnswerBank } from './sections/AnswerBank'
import { Filters } from './sections/Filters'
import { Writing } from './sections/Writing'
import { Connections } from './sections/Connections'
import { Privacy } from './sections/Privacy'

export type Update = (fn: (p: Profile) => Profile) => void

const NAV = [
  ['basics', 'Basics'],
  ['experience', 'Experience'],
  ['education', 'Education'],
  ['skills', 'Skills and links'],
  ['resumes', 'Resumes'],
  ['answers', 'Standard answers'],
  ['bank', 'Answer bank'],
  ['filters', 'Filters'],
  ['writing', 'Writing samples'],
  ['connections', 'Connections'],
  ['privacy', 'Privacy and data'],
] as const

export function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {intro && <p className="mt-1 max-w-2xl text-sm text-muted">{intro}</p>}
      <Card className="mt-4 p-5">{children}</Card>
    </section>
  )
}

export function App() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [locked, setLocked] = useState(false)
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [active, setActive] = useState('basics')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const latest = useRef<Profile | null>(null)

  const load = useCallback(async () => {
    if (await isLocked()) return setLocked(true)
    setLocked(false)
    const p = await getProfile()
    latest.current = p
    setProfile(p)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Saves as you type.
  const update: Update = useCallback((fn) => {
    const prev = latest.current
    if (!prev) return
    const next = fn(prev)
    latest.current = next
    setProfile(next)
    setSaved('saving')
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      await saveProfile(latest.current!)
      setSaved('saved')
    }, 400)
  }, [])

  useEffect(() => {
    const flush = () => latest.current && saved === 'saving' && saveProfile(latest.current)
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [saved])

  // Highlight the section in view.
  useEffect(() => {
    if (!profile) return
    const obs = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (top) setActive(top.target.id)
      },
      { rootMargin: '-10% 0px -70% 0px' },
    )
    NAV.forEach(([id]) => {
      const el = document.getElementById(id)
      if (el) obs.observe(el)
    })
    return () => obs.disconnect()
  }, [profile])

  if (locked) return <UnlockScreen onUnlocked={load} />
  if (!profile)
    return (
      <div className="flex min-h-screen items-center justify-center text-muted">
        <Spinner />
      </div>
    )

  return (
    <div className="mx-auto flex max-w-6xl gap-10 px-4 py-8 sm:px-8">
      <nav className="sticky top-8 hidden h-fit w-48 shrink-0 flex-col gap-0.5 md:flex" aria-label="Sections">
        <div className="mb-4 px-2 text-base font-semibold">Zipply</div>
        {NAV.map(([id, label]) => (
          <a key={id} href={`#${id}`} className={cx('rounded-md px-2 py-1.5 text-sm', active === id ? 'bg-surface font-medium text-ink' : 'text-muted hover:text-ink')}>
            {label}
          </a>
        ))}
        <div className="mt-4 px-2 text-xs text-muted" aria-live="polite">
          {saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'All changes saved' : ''}
        </div>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col gap-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Your profile</h1>
          <p className="mt-1 text-sm text-muted">Entered once, used on every application. Everything stays in this browser, encrypted.</p>
        </header>

        <ResumeDrop profile={profile} update={update} />
        <Basics profile={profile} update={update} />
        <Experience profile={profile} update={update} />
        <Education profile={profile} update={update} />
        <SkillsLinks profile={profile} update={update} />
        <Resumes />
        <StandardAnswers profile={profile} update={update} />
        <AnswerBank />
        <Filters profile={profile} update={update} />
        <Writing profile={profile} update={update} />
        <Connections />
        <Privacy onChanged={load} />
        <footer className="pb-16 text-xs text-muted md:hidden" aria-live="polite">
          {saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'All changes saved' : ''}
        </footer>
      </main>
    </div>
  )
}

function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [pass, setPass] = useState('')
  const [bad, setBad] = useState(false)
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold">Unlock Zipply</h1>
        <p className="mt-1 text-sm text-muted">Enter your passphrase to open your profile.</p>
        <form
          className="mt-4 flex flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            if (await unlock(pass)) onUnlocked()
            else setBad(true)
          }}
        >
          <Input type="password" autoFocus value={pass} onChange={(e) => { setPass(e.target.value); setBad(false) }} placeholder="Passphrase" />
          {bad && <p className="text-xs text-bad">That passphrase didn't work.</p>}
          <Button variant="primary" type="submit">Unlock</Button>
        </form>
      </Card>
    </div>
  )
}

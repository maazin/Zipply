import { useState } from 'react'
import type { Links, Profile } from '@/shared/types'
import { Field, Input } from '@/ui/kit'
import { Section, type Update } from '../App'

const LINKS: [keyof Links, string][] = [
  ['linkedin', 'LinkedIn'],
  ['github', 'GitHub'],
  ['portfolio', 'Website or portfolio'],
  ['other', 'Other link'],
]

export function SkillsLinks({ profile, update }: { profile: Profile; update: Update }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const items = draft.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)
    if (items.length) update((p) => ({ ...p, skills: [...new Set([...p.skills, ...items])] }))
    setDraft('')
  }
  return (
    <Section id="skills" title="Skills and links" intro="Skills feed the match score: a keyword you list here but not on a resume shows up as “Can add”.">
      <Field label="Skills" hint="Type and press Enter. Commas add several at once.">
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} onBlur={add} placeholder="Python, SQL, Tableau" />
      </Field>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {profile.skills.map((s) => (
          <span key={s} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[13px]">
            {s}
            <button aria-label={`Remove ${s}`} className="text-muted hover:text-bad" onClick={() => update((p) => ({ ...p, skills: p.skills.filter((x) => x !== s) }))}>×</button>
          </span>
        ))}
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {LINKS.map(([k, label]) => (
          <Field key={k} label={label}>
            <Input type="url" value={profile.links[k]} placeholder="https://" onChange={(e) => update((p) => ({ ...p, links: { ...p.links, [k]: e.target.value } }))} />
          </Field>
        ))}
      </div>
    </Section>
  )
}

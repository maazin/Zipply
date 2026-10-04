import type { EducationEntry, Profile } from '@/shared/types'
import { uid } from '@/shared/defaults'
import { Button, Field, Input } from '@/ui/kit'
import { Section, type Update } from '../App'

export function Education({ profile, update }: { profile: Profile; update: Update }) {
  const set = (i: number, patch: Partial<EducationEntry>) => update((p) => ({ ...p, education: p.education.map((e, j) => (j === i ? { ...e, ...patch } : e)) }))
  return (
    <Section id="education" title="Education">
      <div className="flex flex-col gap-6">
        {profile.education.map((e, i) => (
          <div key={e.id} className="grid gap-3 border-b border-line pb-6 last:border-0 last:pb-0 sm:grid-cols-2">
            <Field label="School" className="sm:col-span-2"><Input value={e.school} onChange={(ev) => set(i, { school: ev.target.value })} /></Field>
            <Field label="Degree" hint="For example: Bachelor's, Master's"><Input value={e.degree} onChange={(ev) => set(i, { degree: ev.target.value })} /></Field>
            <Field label="Field of study"><Input value={e.major} onChange={(ev) => set(i, { major: ev.target.value })} /></Field>
            <Field label="Start"><Input type="month" value={e.start} onChange={(ev) => set(i, { start: ev.target.value })} /></Field>
            <Field label="Graduation (or expected)"><Input type="month" value={e.end} onChange={(ev) => set(i, { end: ev.target.value })} /></Field>
            <Field label="GPA"><Input value={e.gpa} onChange={(ev) => set(i, { gpa: ev.target.value })} /></Field>
            <div className="flex items-end justify-end">
              <Button size="sm" variant="danger" onClick={() => update((p) => ({ ...p, education: p.education.filter((_, j) => j !== i) }))}>Remove</Button>
            </div>
          </div>
        ))}
        <Button className="self-start" onClick={() => update((p) => ({ ...p, education: [...p.education, { id: uid(), school: '', degree: '', major: '', start: '', end: '', gpa: '' }] }))}>
          Add a school
        </Button>
      </div>
    </Section>
  )
}

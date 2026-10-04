import type { Profile, WorkEntry } from '@/shared/types'
import { uid } from '@/shared/defaults'
import { Button, Field, Input, TextArea } from '@/ui/kit'
import { Section, type Update } from '../App'

export function Experience({ profile, update }: { profile: Profile; update: Update }) {
  const set = (i: number, patch: Partial<WorkEntry>) => update((p) => ({ ...p, work: p.work.map((w, j) => (j === i ? { ...w, ...patch } : w)) }))
  const move = (i: number, d: number) =>
    update((p) => {
      const w = p.work.slice()
      const [x] = w.splice(i, 1)
      w.splice(Math.max(0, Math.min(w.length, i + d)), 0, x)
      return { ...p, work: w }
    })
  return (
    <Section id="experience" title="Experience" intro="Most recent first. The first entry fills “current company” and “current title” fields.">
      <div className="flex flex-col gap-6">
        {profile.work.map((w, i) => (
          <div key={w.id} className="grid gap-3 border-b border-line pb-6 last:border-0 last:pb-0 sm:grid-cols-2">
            <Field label="Title"><Input value={w.title} onChange={(e) => set(i, { title: e.target.value })} /></Field>
            <Field label="Company"><Input value={w.company} onChange={(e) => set(i, { company: e.target.value })} /></Field>
            <Field label="Location"><Input value={w.location} onChange={(e) => set(i, { location: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start"><Input type="month" value={w.start} onChange={(e) => set(i, { start: e.target.value })} /></Field>
              <Field label="End"><Input type="month" value={w.current ? '' : w.end} disabled={w.current} onChange={(e) => set(i, { end: e.target.value })} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" checked={w.current} onChange={(e) => set(i, { current: e.target.checked, end: e.target.checked ? '' : w.end })} />
              I work here now
            </label>
            <Field label="What you did" className="sm:col-span-2">
              <TextArea value={w.description} rows={4} onChange={(e) => set(i, { description: e.target.value })} />
            </Field>
            <div className="flex gap-2 sm:col-span-2">
              <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0}>Move up</Button>
              <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === profile.work.length - 1}>Move down</Button>
              <Button size="sm" variant="danger" className="ml-auto" onClick={() => update((p) => ({ ...p, work: p.work.filter((_, j) => j !== i) }))}>Remove</Button>
            </div>
          </div>
        ))}
        <Button className="self-start" onClick={() => update((p) => ({ ...p, work: [...p.work, { id: uid(), title: '', company: '', location: '', start: '', end: '', current: false, description: '' }] }))}>
          Add a job
        </Button>
      </div>
    </Section>
  )
}

import type { Profile } from '@/shared/types'
import { Button, TextArea } from '@/ui/kit'
import { Section, type Update } from '../App'

export function Writing({ profile, update }: { profile: Profile; update: Update }) {
  const samples = profile.writingSamples
  const set = (i: number, v: string) => update((p) => ({ ...p, writingSamples: p.writingSamples.map((s, j) => (j === i ? v : s)) }))
  return (
    <Section id="writing" title="Writing samples" intro="Two or three past answers you liked. AI drafts copy their voice, not their facts.">
      <div className="flex flex-col gap-3">
        {samples.map((s, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <TextArea rows={4} value={s} onChange={(e) => set(i, e.target.value)} />
            <Button size="sm" variant="ghost" className="self-end" onClick={() => update((p) => ({ ...p, writingSamples: p.writingSamples.filter((_, j) => j !== i) }))}>Remove</Button>
          </div>
        ))}
        {samples.length < 3 && (
          <Button className="self-start" onClick={() => update((p) => ({ ...p, writingSamples: [...p.writingSamples, ''] }))}>Add a sample</Button>
        )}
      </div>
    </Section>
  )
}

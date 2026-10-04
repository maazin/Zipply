import type { Filters as F, Profile } from '@/shared/types'
import { Field, Input, TextArea } from '@/ui/kit'
import { Section, type Update } from '../App'

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)

export function Filters({ profile, update }: { profile: Profile; update: Update }) {
  const f = profile.filters
  const set = <K extends keyof F>(k: K, v: F[K]) => update((p) => ({ ...p, filters: { ...p.filters, [k]: v } }))
  return (
    <Section id="filters" title="Filters" intro="Used by the Apply, Maybe or Skip verdict. A Skip never stops you filling; it just names the reason.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Blocked companies" hint="One per line. “Acme Inc” also blocks “ACME Corp”.">
          <TextArea rows={4} defaultValue={f.blockedCompanies.join('\n')} onBlur={(e) => set('blockedCompanies', lines(e.target.value))} />
        </Field>
        <Field label="Words that rule out a job" hint="Whole words in the posting, e.g. “10+ years”.">
          <TextArea rows={4} defaultValue={f.jobBadWords.join('\n')} onBlur={(e) => set('jobBadWords', lines(e.target.value))} />
        </Field>
        <Field label="Words that rule out a company" hint="e.g. “staffing agency”.">
          <TextArea rows={4} defaultValue={f.companyBadWords.join('\n')} onBlur={(e) => set('companyBadWords', lines(e.target.value))} />
        </Field>
        <Field label="Words that override those" hint="If any appear, the company words above are ignored.">
          <TextArea rows={4} defaultValue={f.companyGoodWords.join('\n')} onBlur={(e) => set('companyGoodWords', lines(e.target.value))} />
        </Field>
        <Field label="Apply at match score">
          <Input type="number" min={0} max={100} value={f.applyAt} onChange={(e) => set('applyAt', Number(e.target.value) || 0)} />
        </Field>
        <Field label="Maybe at match score" hint="Below this is a Skip.">
          <Input type="number" min={0} max={100} value={f.maybeAt} onChange={(e) => set('maybeAt', Number(e.target.value) || 0)} />
        </Field>
      </div>
    </Section>
  )
}

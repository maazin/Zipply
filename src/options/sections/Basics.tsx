import type { Basics as B, Profile } from '@/shared/types'
import { Field, Input, TextArea } from '@/ui/kit'
import { Section, type Update } from '../App'

const FIELDS: [keyof B, string, string?][] = [
  ['firstName', 'First name', 'given-name'],
  ['lastName', 'Last name', 'family-name'],
  ['preferredName', 'Preferred name'],
  ['pronouns', 'Pronouns'],
  ['email', 'Email', 'email'],
  ['phone', 'Phone', 'tel'],
  ['addressLine1', 'Street address', 'address-line1'],
  ['city', 'City', 'address-level2'],
  ['state', 'State or province', 'address-level1'],
  ['postalCode', 'Postal code', 'postal-code'],
  ['country', 'Country', 'country-name'],
  ['headline', 'Headline'],
]

export function Basics({ profile, update }: { profile: Profile; update: Update }) {
  const set = (k: keyof B, v: string) => update((p) => ({ ...p, basics: { ...p.basics, [k]: v } }))
  return (
    <Section id="basics" title="Basics">
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map(([k, label, ac]) => (
          <Field key={k} label={label}>
            <Input value={profile.basics[k]} autoComplete={ac} onChange={(e) => set(k, e.target.value)} />
          </Field>
        ))}
        <Field label="Summary" className="sm:col-span-2" hint="A few sentences. Used for “about you” fields and to ground AI drafts.">
          <TextArea value={profile.basics.summary} onChange={(e) => set('summary', e.target.value)} rows={3} />
        </Field>
      </div>
    </Section>
  )
}

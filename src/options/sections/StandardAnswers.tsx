import type { EmploymentType, Profile, StandardAnswers as SA, WorkMode, YesNo } from '@/shared/types'
import { DECLINE } from '@/shared/defaults'
import { Field, Input, Select } from '@/ui/kit'
import { Section, type Update } from '../App'

function YesNoSelect({ value, onChange }: { value: YesNo; onChange: (v: YesNo) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as YesNo)}>
      <option value="">Not set (left for me)</option>
      <option>Yes</option>
      <option>No</option>
    </Select>
  )
}

const EEO: [keyof SA, string, string[]][] = [
  ['gender', 'Gender', ['Male', 'Female', 'Non-binary']],
  ['race', 'Race or ethnicity', ['American Indian or Alaska Native', 'Asian', 'Black or African American', 'Native Hawaiian or Other Pacific Islander', 'White', 'Two or more races']],
  ['hispanic', 'Hispanic or Latino', ['Yes', 'No']],
  ['veteran', 'Veteran status', ['I am not a protected veteran', 'I identify as one or more of the classifications of protected veteran']],
  ['disability', 'Disability', ['Yes, I have a disability (or previously had a disability)', "No, I don't have a disability"]],
]

export function StandardAnswers({ profile, update }: { profile: Profile; update: Update }) {
  const a = profile.answers
  const set = <K extends keyof SA>(k: K, v: SA[K]) => update((p) => ({ ...p, answers: { ...p.answers, [k]: v } }))
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  return (
    <Section
      id="answers"
      title="Standard answers"
      intro="Work authorization, sponsorship, salary and EEO answers are never guessed. If one isn't set, that field stays empty and is flagged for you."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Authorized to work in the country of the job?"><YesNoSelect value={a.workAuthorized} onChange={(v) => set('workAuthorized', v)} /></Field>
        <Field label="Need visa sponsorship now or later?"><YesNoSelect value={a.needsSponsorship} onChange={(v) => set('needsSponsorship', v)} /></Field>
        <Field label="Willing to relocate?"><YesNoSelect value={a.willingToRelocate} onChange={(v) => set('willingToRelocate', v)} /></Field>
        <Field label="Active security clearance?" hint="“No” makes clearance and polygraph jobs a Skip."><YesNoSelect value={a.hasSecurityClearance} onChange={(v) => set('hasSecurityClearance', v)} /></Field>
        <Field label="Earliest start date" hint="Free text, e.g. “2 weeks notice” or 2026-06-01"><Input value={a.startDate} onChange={(e) => set('startDate', e.target.value)} /></Field>
        <Field label="Salary expectation" hint="What forms get, e.g. “$75,000” or “Open”"><Input value={a.salaryExpectation} onChange={(e) => set('salaryExpectation', e.target.value)} /></Field>
        <Field label="Minimum annual base (for the Pay check)"><Input type="number" min={0} step={1000} value={a.minSalary ?? ''} onChange={(e) => set('minSalary', e.target.value ? Number(e.target.value) : null)} /></Field>
        <Field label="Years of experience" hint="Leave empty to count from your experience"><Input type="number" min={0} step={0.5} value={a.yearsExperience ?? ''} onChange={(e) => set('yearsExperience', e.target.value ? Number(e.target.value) : null)} /></Field>
        <Field label="How did you hear about us?"><Input value={a.howDidYouHear} placeholder="Company website" onChange={(e) => set('howDidYouHear', e.target.value)} /></Field>
        <Field label="Locations you'd work in" hint="Comma separated, e.g. Tampa, FL; Remote">
          <Input value={a.locations.join('; ')} onChange={(e) => set('locations', e.target.value.split(/;|\n/).map((s) => s.trim()).filter(Boolean))} />
        </Field>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-[13px] font-medium">Job types you want</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {(['full-time', 'part-time', 'contract', 'internship'] as EmploymentType[]).map((t) => (
              <label key={t} className="flex items-center gap-1.5"><input type="checkbox" checked={a.employmentTypes.includes(t)} onChange={() => set('employmentTypes', toggle(a.employmentTypes, t))} />{t}</label>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-[13px] font-medium">Work setups you'd take</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {(['remote', 'hybrid', 'onsite'] as WorkMode[]).map((t) => (
              <label key={t} className="flex items-center gap-1.5"><input type="checkbox" checked={a.workModes.includes(t)} onChange={() => set('workModes', toggle(a.workModes, t))} />{t}</label>
            ))}
          </div>
        </fieldset>
      </div>

      <h3 className="mt-8 text-sm font-semibold">Voluntary self-identification (EEO)</h3>
      <p className="mt-1 text-xs text-muted">Defaults to “{DECLINE}”. Change any of these if you want them filled.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {EEO.map(([k, label, opts]) => (
          <Field key={k} label={label}>
            <Select value={a[k] as string} onChange={(e) => set(k, e.target.value as never)}>
              <option>{DECLINE}</option>
              {opts.map((o) => <option key={o}>{o}</option>)}
              <option value="">Not set (left for me)</option>
            </Select>
          </Field>
        ))}
      </div>
    </Section>
  )
}

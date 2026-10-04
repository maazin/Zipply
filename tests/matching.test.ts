import { describe, expect, it } from 'vitest'
import { hungarian } from '@/core/matching/hungarian'
import { scoreField } from '@/core/matching/scorer'
import { pickOption } from '@/core/matching/options'
import { planFields } from '@/core/matching/plan'
import { field, profile } from './helpers'

describe('hungarian', () => {
  it('finds the minimum-cost assignment', () => {
    const r = hungarian([
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ])
    expect(r).toEqual([1, 0, 2])
  })
  it('handles more rows than columns', () => {
    const r = hungarian([[0.1], [0.9], [0.5]])
    expect(r.filter((x) => x === 0)).toHaveLength(1)
    expect(r[0]).toBe(0)
  })
})

describe('scoreField', () => {
  it('uses autocomplete first', () => {
    expect(scoreField(field({ zid: '1', autocomplete: 'given-name' }))[0]).toMatchObject({ key: 'firstName', score: 1 })
  })
  it('understands synonyms', () => {
    expect(scoreField(field({ zid: '1', label: 'Surname' }))[0].key).toBe('lastName')
    expect(scoreField(field({ zid: '1', label: 'Mobile', kind: 'tel' }))[0].key).toBe('phone')
  })
  it('reads identifiers', () => {
    expect(scoreField(field({ zid: '1', name: 'job_application[first_name]' }))[0].key).toBe('firstName')
    expect(scoreField(field({ zid: '1', idAttr: 'candidateEmailAddress' }))[0].key).toBe('email')
  })
  it('does not treat "Company name" as the applicant name', () => {
    expect(scoreField(field({ zid: '1', label: 'Company name' }))[0].key).toBe('currentCompany')
  })
  it('keeps one-word aliases weak inside long questions', () => {
    const top = scoreField(field({ zid: '1', kind: 'textarea', label: 'Why do you want to work at our company?' }))[0]
    expect(top?.score ?? 0).toBeLessThan(0.6)
  })
  it('matches sponsorship questions', () => {
    const f = field({ zid: '1', kind: 'select', label: 'Will you now or in the future require sponsorship for employment visa status?', options: ['Yes', 'No'] })
    expect(scoreField(f)[0].key).toBe('needsSponsorship')
  })
})

describe('pickOption', () => {
  it('maps yes/no answers', () => {
    expect(pickOption(['Select...', 'Yes', 'No'], 'No', { boolean: true }).index).toBe(2)
    expect(pickOption(['Yes, I am authorized', 'No, I am not authorized'], 'Yes', { boolean: true }).index).toBe(0)
  })
  it('maps decline phrasing', () => {
    expect(pickOption(['Male', 'Female', "I don't wish to answer"], 'Decline to answer').index).toBe(2)
  })
  it('maps country variants', () => {
    expect(pickOption(['Canada', 'United States of America', 'Mexico'], 'United States').index).toBe(1)
  })
  it('refuses weak matches', () => {
    expect(pickOption(['Red', 'Green'], 'Bachelor').index).toBe(-1)
  })
})

describe('planFields', () => {
  const p = profile()
  it('fills a basic contact form and never lets two fields claim one key', () => {
    const fields = [
      field({ zid: 'a', label: 'First Name', required: true }),
      field({ zid: 'b', label: 'Last Name' }),
      field({ zid: 'c', label: 'Email', kind: 'email' }),
      field({ zid: 'd', label: 'Phone', kind: 'tel' }),
      field({ zid: 'e', label: 'Phone (alternate)', kind: 'tel' }),
      field({ zid: 'f', label: 'LinkedIn Profile', kind: 'url' }),
    ]
    const plan = planFields(fields, p, { threshold: 0.75 })
    const by = Object.fromEntries(plan.map((x) => [x.zid, x]))
    expect(by.a.value).toBe('Ada')
    expect(by.b.value).toBe('Lovelace')
    expect(by.c.value).toBe('ada@example.com')
    expect(by.f.value).toBe('https://linkedin.com/in/ada')
    const phones = plan.filter((x) => x.key === 'phone')
    expect(phones).toHaveLength(1)
  })
  it('never guesses sensitive answers that are not set', () => {
    const q = profile()
    q.answers.salaryExpectation = ''
    const plan = planFields([field({ zid: 's', label: 'Desired salary' })], q, { threshold: 0.75 })
    expect(plan[0]).toMatchObject({ action: 'skip', key: 'salaryExpectation' })
  })
  it('never ticks attestation boxes', () => {
    const plan = planFields(
      [field({ zid: 'x', kind: 'checkbox', label: 'I certify that I am legally authorized to work in the US' })],
      p,
      { threshold: 0.75 },
    )
    expect(plan[0].action).not.toBe('fill')
  })
  it('defaults EEO answers to decline', () => {
    const plan = planFields(
      [field({ zid: 'g', kind: 'select', label: 'Gender', options: ['Male', 'Female', 'Decline To Self Identify'] })],
      p,
      { threshold: 0.75 },
    )
    expect(plan[0].value).toBe('Decline To Self Identify')
  })
  it('reuses saved answers from the answer bank', () => {
    const plan = planFields([field({ zid: 'q', kind: 'textarea', label: 'Why are you interested in Globex?' })], p, {
      threshold: 0.75,
      bank: [
        { id: '1', label: 'Why are you interested in Globex?', labelNorm: '', answer: 'Because…', fieldKind: 'textarea', host: 'x', source: 'typed', updatedAt: 1, uses: 0 },
      ],
    })
    expect(plan[0]).toMatchObject({ source: 'bank', value: 'Because…' })
  })
  it('leaves unknown questions unresolved', () => {
    const plan = planFields([field({ zid: 'q', kind: 'textarea', label: 'Describe a time you disagreed with a teammate' })], p, { threshold: 0.75 })
    expect(plan[0].action).toBe('unresolved')
  })
})

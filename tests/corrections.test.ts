import { describe, expect, it } from 'vitest'
import { shouldRememberCorrection, upsertAnswer } from '@/core/answerBank'

describe('what counts as a correction worth keeping', () => {
  it('keeps ordinary profile fields, even one-word labels', () => {
    expect(shouldRememberCorrection('Phone', 'phone', '+1 813 555 0199', 'tel')).toBe(true)
    expect(shouldRememberCorrection('Current title', 'currentTitle', 'Analyst II', 'text')).toBe(true)
  })
  it('never keeps sensitive answers, consent boxes or files', () => {
    expect(shouldRememberCorrection('Desired salary', 'salaryExpectation', '90000', 'text')).toBe(false)
    expect(shouldRememberCorrection('Gender', 'gender', 'Female', 'select')).toBe(false)
    expect(shouldRememberCorrection('I agree to the terms', undefined, 'Yes', 'checkbox')).toBe(false)
    expect(shouldRememberCorrection('Resume', 'resume', 'cv.pdf', 'file')).toBe(false)
  })
  it('keeps one correction per site for the same label', () => {
    const base = { label: 'Phone', fieldKind: 'tel' as const, source: 'correction' as const }
    let bank = upsertAnswer([], { ...base, id: 'a', host: 'a.com', answer: '1' }, 1)
    bank = upsertAnswer(bank, { ...base, id: 'b', host: 'b.com', answer: '2' }, 2)
    bank = upsertAnswer(bank, { ...base, id: 'c', host: 'a.com', answer: '3' }, 3)
    expect(bank.map((e) => [e.host, e.answer])).toEqual([['a.com', '3'], ['b.com', '2']])
    // A typed answer with the same label is a separate entry.
    bank = upsertAnswer(bank, { label: 'Phone', fieldKind: 'tel', source: 'typed', id: 'd', host: 'c.com', answer: '4' }, 4)
    expect(bank).toHaveLength(3)
  })
})

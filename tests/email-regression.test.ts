// Real recruiting emails, with the company and person renamed, and the status
// each one should give. Every rule change runs against all of them, so a fix for
// one sender can't quietly break another. Add the next email the rules misread.
import { describe, expect, it } from 'vitest'
import { classifyEmail, isJobAlert } from '@/core/gmail/rules'
import cases from './fixtures/emails.json'

describe('real emails read as the right status', () => {
  for (const c of cases as { why: string; from: string; subject: string; body: string; expect: string }[])
    it(c.why, () => {
      expect(isJobAlert(c.subject, c.body, c.from)).toBe(false)
      expect(classifyEmail(c.subject, c.body)).toBe(c.expect)
    })
})

import { describe, expect, it } from 'vitest'
import { panelSkips } from '@/shared/excluded'

describe('the side panel', () => {
  it('leaves YouTube, Gmail and Docs alone, but still fills Google Forms', () => {
    expect(panelSkips('https://www.youtube.com/watch?v=Dcp02c9LLEw')).toBe(true)
    expect(panelSkips('https://mail.google.com/mail/u/0/')).toBe(true)
    expect(panelSkips('https://docs.google.com/document/d/x/edit')).toBe(true)
    expect(panelSkips('chrome://extensions')).toBe(true)
    expect(panelSkips('https://docs.google.com/forms/d/x/viewform')).toBe(false)
    expect(panelSkips('https://boards.greenhouse.io/acme/jobs/1')).toBe(false)
    expect(panelSkips('http://localhost:5173/form')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { parseResume, parseDate } from '@/core/resume/parse'

const TEXT = `Ada Lovelace
Tampa, FL | ada@example.com | (813) 555-0100 | linkedin.com/in/ada | github.com/ada

Summary
Analyst who turns messy data into decisions.

Experience
Data Analyst Intern | Acme Corp | Tampa, FL
May 2025 - Aug 2025
- Built Tableau dashboards on SQL
- Automated weekly reports in Python
Research Assistant, USF Data Lab
Jan 2024 - Present
- Cleaned survey data

Education
University of South Florida
Bachelor of Science in Computer Science, Expected May 2026
GPA: 3.7

Skills
Languages: Python, SQL, R
Tools: Tableau, Excel, Git`

describe('rule-based resume parsing', () => {
  const r = parseResume(TEXT)
  it('reads contact details and links', () => {
    expect(r.basics).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '(813) 555-0100', city: 'Tampa', state: 'FL' })
    expect(r.links.linkedin).toBe('https://linkedin.com/in/ada')
    expect(r.links.github).toBe('https://github.com/ada')
  })
  it('splits work history with dates', () => {
    expect(r.work).toHaveLength(2)
    expect(r.work[0]).toMatchObject({ title: 'Data Analyst Intern', company: 'Acme Corp', start: '2025-05', end: '2025-08', current: false })
    expect(r.work[0].description).toContain('Tableau')
    expect(r.work[1]).toMatchObject({ title: 'Research Assistant', company: 'USF Data Lab', current: true })
  })
  it('reads education', () => {
    expect(r.education[0]).toMatchObject({ school: 'University of South Florida', gpa: '3.7', end: '2026-05' })
    expect(r.education[0].degree).toMatch(/Bachelor/)
  })
  it('reads skills', () => {
    expect(r.skills).toEqual(expect.arrayContaining(['Python', 'SQL', 'Tableau', 'Git']))
  })
  it('parses dates', () => {
    expect(parseDate('September 2024')).toBe('2024-09')
    expect(parseDate('03/2022')).toBe('2022-03')
    expect(parseDate('2021')).toBe('2021')
  })
})

// Up to 10 resumes, all of them scored against a pasted job description.
import { beforeEach, describe, expect, it } from 'vitest'
import { installChrome, resetStores } from './chromeMock'

installChrome()

const { saveResume, listResumes, MAX_RESUMES } = await import('@/lib/repo')
const { compareDescription } = await import('@/lib/checks')
const { db } = await import('@/lib/db')
const { emptyProfile } = await import('@/shared/defaults')

beforeEach(async () => {
  resetStores()
  await Promise.all(db.tables.map((t) => t.clear()))
})

const SKILLS = ['SQL', 'Python', 'Tableau', 'Excel', 'React', 'Node', 'Go', 'Kubernetes', 'Java', 'AWS']
const resume = (i: number) => ({
  name: `resume-${i}.pdf`,
  tag: `Tag ${i}`,
  mime: 'application/pdf',
  size: 1000,
  data: '',
  // Resume i lists the first i skills, so a higher number is a better fit for a posting that wants them all.
  content: { text: `Summary\nExperience\nWorked with ${SKILLS.slice(0, i).join(', ')}.\nEducation\nBS\nSkills\n${SKILLS.slice(0, i).join(', ')}` },
})

describe('resume library', () => {
  it('keeps up to 10 resumes and refuses an 11th', async () => {
    expect(MAX_RESUMES).toBe(10)
    for (let i = 1; i <= 10; i++) await saveResume(resume(i))
    expect(await listResumes()).toHaveLength(10)
    await expect(saveResume(resume(11))).rejects.toThrow('up to 10 resumes')
  })

  it('scores all 10 against a pasted description and picks the best', async () => {
    for (let i = 1; i <= 10; i++) await saveResume(resume(i))
    const posting = `Engineer. Requirements: ${SKILLS.join(', ')}. You will build data pipelines and services. `.repeat(2)
    const { comparison, matches } = await compareDescription(posting, emptyProfile())
    expect(matches).toHaveLength(10)
    expect(comparison.rows).toHaveLength(10)
    expect(comparison.rows[0].label).toBe('Tag 10')
    expect(comparison.rows.at(-1)!.label).toBe('Tag 1')
    expect(comparison.rows.map((r) => r.score)).toEqual([...comparison.rows.map((r) => r.score)].sort((a, b) => b - a))
    expect(comparison.why).toMatch(/^Tag 10 /)
  })
})

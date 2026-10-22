import { describe, expect, it } from 'vitest'
import { compareResumes } from '@/core/score/compare'
import { rankResumes } from '@/core/score/matchScore'
import { pillLabel, pillTitle } from '@/content/listings'
import { emptyProfile } from '@/shared/defaults'

const m = (resumeId: string, score: number, matched: string[], tag = '', name = `${resumeId}.pdf`) => ({ resumeId, score, matched, tag, name })

describe('comparing resumes', () => {
  it('ranks best first and says why the best one wins', () => {
    const c = compareResumes([m('swe', 61, ['Python', 'Go'], 'Backend'), m('data', 82, ['Python', 'SQL', 'Tableau', 'dbt'], 'Data')])
    expect(c.bestId).toBe('data')
    expect(c.close).toBe(false)
    expect(c.rows.map((r) => [r.label, r.score, r.behind])).toEqual([['Data', 82, 0], ['Backend', 61, 21]])
    expect(c.rows[1]).toMatchObject({ edge: ['Go'], lacks: ['SQL', 'Tableau', 'dbt'] })
    expect(c.why).toBe('Data scores 21 points above Backend: it covers SQL, Tableau, dbt.')
  })

  it('calls a near tie a close call and names what the runner-up has', () => {
    const c = compareResumes([m('a', 74, ['React', 'TypeScript'], 'Frontend'), m('b', 72, ['React', 'Node'], 'Full-stack')])
    expect(c.close).toBe(true)
    expect(c.why).toBe('Frontend and Full-stack are within 2 points. Full-stack covers Node, so pick the one that suits this role.')
  })

  it('breaks an exact tie by the number of posting terms covered', () => {
    const c = compareResumes([m('a', 70, ['SQL'], 'A'), m('b', 70, ['SQL', 'Python'], 'B')])
    expect(c.bestId).toBe('b')
    expect(c.why).toMatch(/^B and A fit equally well/)
  })

  it('falls back to the file name and handles one or no resumes', () => {
    expect(compareResumes([m('x', 50, [])])).toMatchObject({ bestId: 'x', why: 'Your only resume.', rows: [{ label: 'x.pdf' }] })
    expect(compareResumes([])).toEqual({ bestId: null, close: false, why: '', rows: [] })
  })

  it('scores real resume text and puts the better fit first', () => {
    const posting = 'Data Analyst. Requirements: SQL, Python, Tableau and Excel. Nice to have: dbt, Snowflake. '.repeat(3)
    const ranked = rankResumes(
      [
        { id: 'web', text: 'Summary\nExperience\nBuilt React and Node apps.\nEducation\nBS CS\nSkills\nReact, Node, CSS' },
        { id: 'data', text: 'Summary\nExperience\nBuilt Tableau dashboards with SQL and Python.\nEducation\nBS Stats\nSkills\nSQL, Python, Tableau, Excel, dbt' },
      ],
      posting,
      emptyProfile(),
    )
    const c = compareResumes(ranked.map((r) => ({ ...r, tag: r.resumeId })))
    expect(c.bestId).toBe('data')
    expect(c.rows[0].score).toBeGreaterThan(c.rows[1].score)
    expect(c.rows[1].lacks).toEqual(expect.arrayContaining(['SQL', 'Tableau']))
  })
})

describe('listing pill text', () => {
  const s = { score: 78, verdict: 'Apply' as const, reason: 'Strong match', applied: false }

  it('names the best resume only when you have more than one', () => {
    expect(pillLabel({ ...s, resumes: [{ label: 'Data', score: 78 }] })).toBe('78 · Apply')
    expect(pillLabel({ ...s, resumes: [{ label: 'Data', score: 78 }, { label: 'Backend', score: 60 }] })).toBe('78 · Apply · Data')
    expect(pillLabel({ ...s, resumes: [{ label: 'A very long resume name.pdf', score: 78 }, { label: 'B', score: 1 }] })).toBe('78 · Apply · A very long res…')
    expect(pillLabel({ ...s, applied: true, resumes: [{ label: 'Data', score: 78 }, { label: 'B', score: 1 }] })).toBe('Applied')
  })

  it('lists every resume score on hover, and escapes names', () => {
    expect(pillTitle({ ...s, resumes: [{ label: 'Data', score: 78 }, { label: 'Backend', score: 60 }, { label: 'General', score: 55 }] })).toBe(
      'Zipply: Strong match\nBest resume: Data (78)\nOthers: Backend 60, General 55',
    )
    expect(pillLabel({ ...s, resumes: [{ label: '<b>x</b>', score: 78 }, { label: 'B', score: 1 }] })).toBe('78 · Apply · &lt;b>x&lt;/b>')
  })
})

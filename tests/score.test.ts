import { describe, expect, it } from 'vitest'
import { extractKeywords, splitPosting, hasSkill } from '@/core/score/keywords'
import { computeMatch, sectionCompleteness } from '@/core/score/matchScore'
import { computeVerdict } from '@/core/score/verdict'
import { computeRedFlags, tierFor } from '@/core/score/redFlags'
import { checkApplied } from '@/core/score/applied'
import { parseSalary, yearsRequired, sponsorshipStance } from '@/core/score/postingSignals'
import { atsReport, columnSwitches } from '@/core/score/atsCheck'
import { keywordInText, normalizeCompany } from '@/shared/text'
import type { AppliedEntry, PageLayout } from '@/shared/types'
import { posting, profile } from './helpers'

const JD = `About the role
You will turn data into decisions for our operations team.

Requirements:
- 1+ years of experience with SQL and Python
- Experience building dashboards in Tableau or Power BI
- Strong Excel skills

Nice to have:
- Experience with Snowflake and dbt
- Familiarity with AWS

Benefits
Health insurance, 401k.
${'We value curiosity and ownership in everything we build. '.repeat(20)}`

const RESUME = `Ada Lovelace
ada@example.com | (813) 555-0100
Summary
Data analyst who likes clean pipelines.
Experience
Data Analyst Intern, Acme Corp, May 2025 - Aug 2025
- Built Tableau dashboards on SQL
- Automated reports with Python
Education
University of South Florida, BS Computer Science, 2026
Skills
Python, SQL, Tableau, Excel`

describe('whole-word matching (Resume-Matcher _keyword_in_text)', () => {
  it('never matches Java inside JavaScript', () => {
    expect(keywordInText('Java', 'We use JavaScript')).toBe(false)
    expect(keywordInText('C++', 'Modern C++ and Rust')).toBe(true)
    expect(keywordInText('.NET', 'ASP.NET Core')).toBe(true)
  })
  it('counts synonyms', () => {
    expect(hasSkill('JavaScript', 'Strong JS fundamentals')).toBe(true)
    expect(hasSkill('C', 'Experience with C-suite stakeholders')).toBe(false)
    expect(hasSkill('R', 'R&D budget')).toBe(false)
  })
})

describe('keywords', () => {
  it('splits required and preferred sections', () => {
    const s = splitPosting(JD)
    expect(s.required).toContain('SQL')
    expect(s.preferred).toContain('Snowflake')
  })
  it('ranks required terms above preferred', () => {
    const k = extractKeywords(JD)
    const sql = k.find((x) => x.term === 'SQL')!
    const snow = k.find((x) => x.term === 'Snowflake')!
    expect(sql.tier).toBe('required')
    expect(snow.tier).toBe('preferred')
    expect(sql.weight).toBeGreaterThan(snow.weight)
  })
})

describe('match score (Resume-Matcher compute_ats_score)', () => {
  it('weights keyword, skills and sections 0.55 / 0.25 / 0.20', () => {
    const r = computeMatch({ resumeId: 'r', resumeText: RESUME, posting: JD, profile: profile() })
    const expected = Math.round(r.keywordMatch * 0.55 + r.skillsCoverage * 0.25 + r.sectionCompleteness * 0.2)
    expect(Math.abs(r.score - expected)).toBeLessThanOrEqual(1)
    expect(r.sectionCompleteness).toBe(100)
    expect(r.matched).toEqual(expect.arrayContaining(['SQL', 'Python', 'Tableau', 'Excel']))
  })
  it('splits missing keywords into Can add and Real gap', () => {
    const p = profile()
    p.skills.push('AWS')
    const r = computeMatch({ resumeId: 'r', resumeText: RESUME, posting: JD, profile: p })
    expect(r.canAdd).toContain('AWS')
    expect(r.realGap).toEqual(expect.arrayContaining(['Snowflake', 'dbt']))
    expect(r.tips.join(' ')).not.toMatch(/Snowflake/)
  })
  it('finds sections', () => {
    expect(sectionCompleteness('Experience\nfoo\nEducation\nbar')).toBe(50)
  })
})

describe('posting signals', () => {
  it('reads years of experience like re_experience', () => {
    expect(yearsRequired('3-5 years of experience; 10+ years preferred')).toBe(10)
    expect(yearsRequired('a 4-year degree and 2 years of SQL')).toBe(2)
  })
  it('parses salary ranges', () => {
    expect(parseSalary('Pay: $60,000 - $120,000 per year')).toMatchObject({ min: 60000, max: 120000, period: 'year' })
    expect(parseSalary('$45/hr to $55/hr')).toMatchObject({ min: 45, max: 55, period: 'hour' })
    expect(parseSalary('$90k–$110k')).toMatchObject({ min: 90000, max: 110000 })
  })
  it('lets a sponsorship offer win over refusal wording', () => {
    expect(sponsorshipStance('We are unable to sponsor new visas, but we will sponsor H-1B transfers').stance).toBe('offered')
    expect(sponsorshipStance('We are unable to sponsor visas').stance).toBe('refused')
  })
})

describe('verdict (career-ops rubric)', () => {
  it('says Apply for a strong, clean match', () => {
    const v = computeVerdict({ posting: posting({ description: JD, salary: { min: 70000, max: 85000, currency: 'USD', period: 'year' } }), profile: profile(), matchScore: 82 })
    expect(v.verdict).toBe('Apply')
  })
  it('says Skip on a hard blocker regardless of score', () => {
    const p = profile()
    p.answers.needsSponsorship = 'Yes'
    const v = computeVerdict({ posting: posting({ description: JD + '\nWe do not sponsor visas.' }), profile: p, matchScore: 95 })
    expect(v.verdict).toBe('Skip')
    expect(v.reason).toMatch(/sponsor/i)
  })
  it('skips blocklisted companies (normalized)', () => {
    const p = profile()
    p.filters.blockedCompanies = ['GLOBEX INC']
    expect(computeVerdict({ posting: posting({ description: JD }), profile: p, matchScore: 90 }).verdict).toBe('Skip')
  })
  it('skips clearance roles when you have none', () => {
    const p = profile()
    p.answers.hasSecurityClearance = 'No'
    const v = computeVerdict({ posting: posting({ description: JD + '\nActive TS/SCI clearance with polygraph required.' }), profile: p, matchScore: 90 })
    expect(v.verdict).toBe('Skip')
  })
  it('says Maybe on one warning', () => {
    const v = computeVerdict({ posting: posting({ title: 'Senior Data Analyst', description: JD }), profile: profile(), matchScore: 80 })
    expect(v.verdict).toBe('Maybe')
  })
  it('says Skip under the maybe threshold', () => {
    expect(computeVerdict({ posting: posting({ description: JD }), profile: profile(), matchScore: 40 }).verdict).toBe('Skip')
  })
})

describe('red flags (career-ops Block G)', () => {
  const now = new Date('2026-10-04T12:00:00')
  it('flags old, vague, wide-range contract postings', () => {
    const r = computeRedFlags(
      posting({ description: 'Contract-to-hire. Python.', datePosted: '2026-08-01', salary: { min: 60000, max: 120000, currency: 'USD', period: 'year' } }),
      profile(),
      [],
      now,
    )
    expect(r.flags.join('|')).toMatch(/Posted 64 days ago/)
    expect(r.flags.join('|')).toMatch(/Wide salary range/)
    expect(r.flags.join('|')).toMatch(/Vague posting/)
    expect(r.flags.join('|')).toMatch(/Contract wording/)
    expect(r.tier).toBe('Suspicious')
  })
  it('has three tiers', () => {
    expect(tierFor(0)).toBe('High confidence')
    expect(tierFor(2)).toBe('Proceed with caution')
    expect(tierFor(3)).toBe('Suspicious')
  })
})

describe('already applied', () => {
  const entry = (o: Partial<AppliedEntry>): AppliedEntry => ({
    key: '', appId: 'a1', company: 'Globex Inc', companyNorm: normalizeCompany('Globex Inc'), title: 'Data Analyst I', jobId: 'R-100',
    url: '', dateApplied: '2026-09-20', status: 'Applied', firstReply: '', lastStatusChange: '', ...o,
  })
  const now = new Date('2026-10-04')
  it('finds the same job by company and job ID', () => {
    expect(checkApplied(posting(), [entry({})], now).alreadyApplied).not.toBeNull()
  })
  it('warns softly about the same job on another ATS', () => {
    const r = checkApplied(posting({ jobId: '55512', url: 'https://boards.greenhouse.io/globex/jobs/55512' }), [entry({ title: 'Data Analyst 1' })], now)
    expect(r.alreadyApplied).toBeNull()
    expect(r.possiblyApplied).not.toBeNull()
  })
})

describe('ATS readability', () => {
  const line = (y: number, x: number, str: string) => ({ str, x, y, w: 100, h: 10 })
  it('grades a clean single-column PDF as Good', () => {
    const items = RESUME.split('\n').map((l, i) => line(740 - i * 14, 50, l + ' '.repeat(5) + 'lorem ipsum dolor sit amet consectetur'))
    const r = atsReport({ text: RESUME, pages: [{ width: 612, height: 792, items }] })
    expect(r.grade).toBe('Good')
  })
  it('detects interleaved columns', () => {
    const items = Array.from({ length: 20 }, (_, i) => line(700 - Math.floor(i / 2) * 14, i % 2 ? 350 : 40, i % 2 ? 'Right column sentence that is long enough to count' : 'Left column text'))
    const p: PageLayout = { width: 612, height: 792, items }
    expect(columnSwitches(p).switches).toBeGreaterThan(4)
  })
  it('grades an image-only PDF as Broken', () => {
    expect(atsReport({ text: '', pages: [{ width: 612, height: 792, items: [] }] }).grade).toBe('Broken')
  })
  it('flags ligatures and private-use glyphs', () => {
    const r = atsReport({ text: RESUME + 'ﬁ'.repeat(30) + ''.repeat(30) })
    expect(r.checks.find((c) => c.name === 'Clean characters')!.pass).toBe(false)
  })
})

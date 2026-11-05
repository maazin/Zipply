import { describe, expect, it } from 'vitest'
import { extractKeywords, splitPosting, hasSkill } from '@/core/score/keywords'
import { computeMatch, sectionCompleteness } from '@/core/score/matchScore'
import { computeVerdict } from '@/core/score/verdict'
import { computeRedFlags, tierFor } from '@/core/score/redFlags'
import { appliedLine, checkApplied } from '@/core/score/applied'
import { parseSalary, yearsRequired, sponsorshipStance } from '@/core/score/postingSignals'
import { atsReport, columnSwitches } from '@/core/score/atsCheck'
import { keywordInText, normalizeCompany } from '@/shared/text'
import type { AppliedEntry, PageLayout } from '@/shared/types'
import { migrate } from '@/lib/repo'
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
  it('leaves out what the employer says about itself, its benefits and the legal notes', () => {
    const jd = `About Globex
Globex runs on Kubernetes and Salesforce across 40 countries.

What you'll do
Build reports for the finance team.

Requirements:
- Python and SQL

Benefits
Free AWS certification courses.

Globex is an equal opportunity employer and does not discriminate; we use Tableau to track hiring.`
    const terms = extractKeywords(jd).map((k) => k.term)
    expect(terms).toEqual(expect.arrayContaining(['Python', 'SQL']))
    expect(terms).not.toContain('Kubernetes')
    expect(terms).not.toContain('Salesforce')
    expect(terms).not.toContain('AWS')
    expect(terms).not.toContain('Tableau')
    // "About you" is about you, not the employer.
    expect(splitPosting('About you:\n- Strong Excel skills').required).toContain('Excel')
  })
  it("doesn't drop a one-line description for the legal sentence in it (Workday's NASCAR posting)", () => {
    // Workday's structured data: the whole posting on one line, its EEO note in the middle.
    const jd =
      'At NASCAR, you will work alongside passionate people. What You Will Do: Prepare, combine, and analyze data using SQL and Python. ' +
      'Apply statistical methods and support predictive modeling. What You Will Bring: Degree in Data Science or Statistics. ' +
      'Understanding of core statistical concepts and familiarity with basic machine learning methods and model evaluation. ' +
      'Foundational understanding of generative AI. NASCAR is an Equal Opportunity Employer and does not discriminate. ' +
      'For more information visit www.NASCAR.com and follow NASCAR on Instagram.'
    const terms = extractKeywords(jd).filter((k) => k.tech).map((k) => k.term)
    expect(terms).toEqual(expect.arrayContaining(['SQL', 'Python', 'Machine learning', 'Statistics']))
  })
  it('reads the job after an "About <Company>" section, whatever its headings are called', () => {
    const terms = (jd: string) => extractKeywords(jd).filter((k) => k.tech).map((k) => k.term)
    const about = 'About Initech\nInitech builds payroll software for 4,000 companies.\nWe were founded in 1999.\n'
    for (const head of ['Job Description', 'About this role', 'Key Responsibilities', "What you'll bring", 'Minimum Requirements', 'Position Summary:', 'The Team We Need:'])
      expect(terms(`${about}${head}\n- Build ETL pipelines in Python and SQL\n- Deploy on AWS with Docker`), head).toEqual(expect.arrayContaining(['Python', 'SQL', 'AWS', 'Docker']))
    // A heading it has never seen still doesn't lose the job: most of the posting would have gone, so it reads all of it.
    expect(terms(`${about}Here's the gig\n- Python, SQL and Spark daily\n- Airflow and dbt for orchestration\n- Ship to AWS`)).toEqual(expect.arrayContaining(['Python', 'SQL', 'Spark']))
  })
})

describe('keyword matching on real postings', () => {
  it('reads hyphens and spaces the same way', () => {
    expect(hasSkill('RAG', 'Implement retrieval-augmented generation patterns')).toBe(true)
    expect(hasSkill('AI agents', 'Build agent-based systems')).toBe(true)
    expect(hasSkill('Object-oriented programming', 'object oriented programming')).toBe(true)
  })
  it('ignores look-alikes', () => {
    // "D.C." is a place, "Elastic Kubernetes Service" isn't Elasticsearch.
    const terms = extractKeywords('Washington, D.C.: $150,000\nAmazon Elastic Kubernetes Service').map((k) => k.term)
    expect(terms).not.toContain('C')
    expect(terms).not.toContain('Elasticsearch')
    expect(terms).toContain('Kubernetes')
    expect(extractKeywords('Experience with C or C++.').map((k) => k.term)).toEqual(expect.arrayContaining(['C', 'C++']))
  })
  it('leaves out traits no keyword proves', () => {
    const terms = extractKeywords('Strong communication, leadership and problem-solving skills. Python required.').map((k) => k.term)
    expect(terms).toEqual(['Python'])
  })
  it('costs less to miss a generic term than a tool', () => {
    const jd = 'Requirements:\n- Python\n- Agile'
    const noAgile = computeMatch({ resumeId: 'a', resumeText: 'Skills\nPython', posting: jd, profile: profile() })
    const noPython = computeMatch({ resumeId: 'b', resumeText: 'Skills\nAgile', posting: jd, profile: profile() })
    expect(noAgile.keywordMatch).toBeGreaterThan(noPython.keywordMatch)
  })
})

describe('verdict thresholds', () => {
  it('moves the old defaults to the new ones and keeps ones you chose', () => {
    const base = profile()
    const at = (applyAt: number, maybeAt: number, scoreVersion?: number) => migrate({ ...base, filters: { ...base.filters, applyAt, maybeAt, scoreVersion } }).filters
    expect(at(70, 50)).toMatchObject({ applyAt: 65, maybeAt: 45, scoreVersion: 2 })
    expect(at(80, 60)).toMatchObject({ applyAt: 80, maybeAt: 60, scoreVersion: 2 })
    expect(at(70, 50, 2)).toMatchObject({ applyAt: 70, maybeAt: 50 })
  })
})

describe('match score (Resume-Matcher compute_ats_score)', () => {
  it('weights keywords, skills, title, sections and dates 0.40 / 0.20 / 0.15 / 0.15 / 0.10', () => {
    const r = computeMatch({ resumeId: 'r', resumeText: RESUME, posting: JD, profile: profile(), jobTitle: 'Data Analyst' })
    const expected = Math.round(r.keywordMatch * 0.4 + r.skillsCoverage * 0.2 + r.titleMatch! * 0.15 + r.sectionCompleteness * 0.15 + r.dateConsistency! * 0.1)
    expect(Math.abs(r.score - expected)).toBeLessThanOrEqual(1)
    // Four sections and an email or phone.
    expect(r.sectionCompleteness).toBe(100)
    expect(r.matched).toEqual(expect.arrayContaining(['SQL', 'Python', 'Tableau', 'Excel']))
  })
  it('leaves out what it can\'t measure and shares its weight', () => {
    // No job title (a pasted description): the other four carry the score.
    const r = computeMatch({ resumeId: 'r', resumeText: RESUME, posting: JD, profile: profile() })
    expect(r.titleMatch).toBeNull()
    const expected = Math.round((r.keywordMatch * 0.4 + r.skillsCoverage * 0.2 + r.sectionCompleteness * 0.15 + r.dateConsistency! * 0.1) / 0.85)
    expect(Math.abs(r.score - expected)).toBeLessThanOrEqual(1)
  })
  it('matches the job title in the headline, the summary, or by its words, ignoring seniority', async () => {
    const { titleMatch, dateConsistency } = await import('@/core/score/matchScore')
    expect(titleMatch('Junior Data Scientist', 'Ada Lovelace\nData Scientist\nada@example.com')).toBe(100)
    expect(titleMatch('Data Analyst II', 'Ada Lovelace\nada@example.com\nTampa, FL\nSummary\nA data analyst who likes clean pipelines.')).toBe(75)
    expect(titleMatch('Machine Learning Engineer', 'Ada Lovelace\nSoftware Engineer\nada@example.com')).toBeCloseTo(50 / 3)
    expect(titleMatch('', 'anything')).toBeNull()
    // Dates in one style score 100; mixed styles less; fewer than two, not at all.
    expect(dateConsistency('May 2024 - Aug 2025\nJan 2023 - Apr 2024')).toBe(100)
    expect(dateConsistency('May 2024 - 08/2025\n2023-01 - Apr 2024')).toBe(50)
    expect(dateConsistency('Since 2024')).toBeNull()
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
    // Two of four sections and no way to reach you: 2 of 5.
    expect(sectionCompleteness('Experience\nfoo\nEducation\nbar')).toBe(40)
    expect(sectionCompleteness('ada@example.com\nExperience\nfoo\nEducation\nbar')).toBe(60)
    expect(sectionCompleteness('(813) 555-0100\nExperience\nfoo')).toBe(40)
    // A date range isn't a phone number.
    expect(sectionCompleteness('Experience\nMay 2024 - 2025 1234')).toBe(20)
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
  it('finds the same job by company and job ID, and says when', () => {
    const r = checkApplied(posting(), [entry({ status: 'Rejected' })])
    expect(r.alreadyApplied).not.toBeNull()
    expect(appliedLine(r)).toEqual({ text: 'You applied on Sep 20, 2026 · Rejected', sure: true })
  })
  it('warns softly about the same job on another ATS, however long ago', () => {
    const r = checkApplied(posting({ jobId: '55512', url: 'https://boards.greenhouse.io/globex/jobs/55512' }), [entry({ title: 'Data Analyst 1', dateApplied: '2026-03-02' })])
    expect(r.alreadyApplied).toBeNull()
    expect(r.possiblyApplied).not.toBeNull()
    expect(appliedLine(r)?.text).toBe('You applied for “Data Analyst 1” here on Mar 2, 2026')
  })
  it('names the company when the application found in email has no role saved', () => {
    const r = checkApplied(posting({ jobId: '', url: 'https://globex.com/careers/9' }), [entry({ title: '', jobId: '', company: 'Globex', companyNorm: 'globex', status: 'Received', dateApplied: '2026-10-22' })])
    expect(appliedLine(r)).toEqual({ text: 'You applied to Globex on Oct 22, 2026 · Received (role not saved)', sure: false })
  })
  it("says nothing for another role at a company you've applied to", () => {
    const r = checkApplied(posting({ jobId: '', title: 'Warehouse Lead', url: 'https://globex.com/careers/7' }), [entry({ title: 'Data Analyst I' })])
    expect(appliedLine(r)).toBeNull()
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

describe('clearance', () => {
  it('only counts a government clearance the job requires you to hold', async () => {
    const { clearanceAsk } = await import('@/core/score/postingSignals')
    const asks = [
      'Active TS/SCI clearance with polygraph required.',
      'Must hold an active Secret clearance and not require sponsorship.',
      'Clearance: Top Secret',
      'U.S. citizens with a current DoD clearance only.',
      '- Active Secret clearance',
      'Applicants must hold a Top Secret clearance.',
    ]
    for (const d of asks) expect(clearanceAsk(d), d).not.toBeNull()
    const fine = [
      'This position does not require a security clearance.',
      'No security clearance required.',
      'Security clearance is not required for this role.',
      'Offer contingent on background check clearance and drug screening.',
      'Candidates must complete medical clearance before starting.',
      'Must be able to obtain a security clearance.',
      'Applicants must be eligible for a Secret clearance.',
      'We are a clearance retailer serving outdoor brands.',
      'Active security clearance preferred.',
      'A Secret clearance is a plus.',
      'Some positions may require a security clearance.',
      'Security clearance, if applicable, will be verified after an offer.',
      'Experience working with federal clients; security clearance desirable.',
      'Our team supports customers in the public sector and defense industries, including programs with security clearance work.',
    ]
    for (const d of fine) expect(clearanceAsk(d), d).toBeNull()
  })

  it("doesn't skip a job for saying no clearance is needed", () => {
    const p = profile()
    p.answers.hasSecurityClearance = 'No'
    const v = computeVerdict({ posting: posting({ description: JD + '\nThis position does not require a security clearance.' }), profile: p, matchScore: 90 })
    expect(v.blockers.join(' ')).not.toMatch(/clearance/)
  })
})

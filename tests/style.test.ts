import { describe, expect, it, vi } from 'vitest'
import { questionKind, styleIssues, tidy, WRITING_RULES } from '@/core/ai/style'
import { answerPrompt, coverLetterPrompt, focus, tailoringPrompt } from '@/core/ai/prompts'
import { profile, posting } from './helpers'

const runAi = vi.fn()
vi.mock('@/background/ai/router', () => ({ runAi: (...a: unknown[]) => runAi(...a), runAiJson: vi.fn() }))
const { polish } = await import('@/background/ai/tasks')

const CHATBOT = `Dear Hiring Manager,

I am thrilled to apply for this role! With a proven track record of leveraging data, I am passionate about delivering cutting-edge insights — and I thrive in fast-paced environments. Moreover, my unique blend of skills aligns with my values.

I look forward to hearing from you.

Sincerely,
[Your Name]`

const HUMAN = `I build the reports operations teams check every Monday. At Acme Corp I moved our weekly numbers from a pile of spreadsheets into Tableau dashboards on SQL, and the team stopped asking me for one-off pulls. Your posting asks for SQL and Tableau first, which is most of what I did there.`

describe('writing style', () => {
  it('flags the habits that make a draft read like a chatbot', () => {
    const issues = styleIssues(CHATBOT)
    for (const l of ['em or en dashes', '"I\'m excited/thrilled"', '"passionate"', '"leverage/utilize"', 'resume clichés', 'stiff transitions (Moreover, Furthermore...)', 'stock closing lines', 'exclamation marks', 'placeholders in [brackets]'])
      expect(issues, l).toContain(l)
  })

  it('leaves a plain, specific answer alone', () => {
    expect(styleIssues(HUMAN)).toEqual([])
    expect(tidy(HUMAN)).toBe(HUMAN)
  })

  it('strips greetings, sign-offs, markdown and em dashes without a model', () => {
    const t = tidy('Dear Hiring Manager,\n\nI built **three** dashboards — all in Tableau.\n\nBest regards,\n[Your Name]')
    expect(t).toBe('I built three dashboards, all in Tableau.')
  })

  it('keeps bullets when bullets were asked for', () => {
    const t = '- Built Tableau dashboards on SQL\n- Automated weekly reports in Python'
    expect(tidy(t, { bullets: true })).toBe(t)
    expect(styleIssues(t, { bullets: true })).toEqual([])
  })

  it('recognizes the common application questions', () => {
    expect(questionKind('Why do you want to work at Globex?')).toBe('whyCompany')
    expect(questionKind('What interests you about this role?')).toBe('whyRole')
    expect(questionKind('Tell us about a time you disagreed with a teammate.')).toBe('story')
    expect(questionKind('Describe a project you are most proud of.')).toBe('project')
    expect(questionKind('What is your greatest weakness?')).toBe('weakness')
    expect(questionKind('Why should we hire you?')).toBe('strengths')
    expect(questionKind('Where do you see yourself in five years?')).toBe('goals')
    expect(questionKind('Tell us about yourself')).toBe('aboutYou')
    expect(questionKind('Is there anything else you would like us to know?')).toBe('extra')
    expect(questionKind('Preferred pronouns')).toBe('other')
  })
})

describe('writing prompts', () => {
  const job = posting({ title: 'Data Analyst', company: 'Globex', description: 'About us\nRequirements:\n- SQL, Python and Tableau\nPreferred:\n- dbt, Snowflake\nYou will build dashboards for operations.' })

  it("tell the model what this team requires most", () => {
    const f = focus(job)
    expect(f).toContain('Role: Data Analyst at Globex')
    expect(f).toMatch(/They require: .*SQL/)
    expect(f).toMatch(/Nice to have: .*dbt/)
    // A posting with no sections still gets a focus.
    expect(focus(posting({ title: 'Analyst', company: '', description: 'We use SQL and Tableau every day, and some Python.' }))).toMatch(/They ask for: .*SQL/)
  })

  it('give each question type its own aim, plus the shared rules', () => {
    const why = answerPrompt('Why do you want to work at Globex?', job, profile())
    expect(why.prompt).toContain('picked them on purpose')
    expect(why.system).toContain(WRITING_RULES)
    expect(why.system).toContain('recruiter or hiring manager')
    const story = answerPrompt('Tell us about a time you fixed a broken process.', job, profile())
    expect(story.prompt).toContain('Tell one real story')
  })

  it('shape the cover letter for a thirty second read', () => {
    const { system, prompt } = coverLetterPrompt(job, profile())
    expect(system).toContain('thirty seconds')
    expect(prompt).toContain('150 to 250 words')
    expect(prompt).toContain('No stock closing lines')
    expect(prompt).not.toContain('Lovelace')
  })

  it('ask for bullets hiring teams skim well', () => {
    expect(tailoringPrompt(job, '- Built dashboards', ['dbt']).prompt).toMatch(/strong past-tense verb.*under 25 words/s)
  })
})

describe('polish', () => {
  it('rewrites once when chatbot habits remain, and keeps the cleaner version', async () => {
    runAi.mockReset().mockResolvedValueOnce({ text: HUMAN, model: 'm' })
    const out = await polish('I am passionate about data and I leverage SQL daily!', 150)
    expect(out).toBe(HUMAN)
    expect(runAi).toHaveBeenCalledTimes(1)
  })

  it('skips the rewrite when the draft is already clean', async () => {
    runAi.mockReset()
    expect(await polish(HUMAN, 150)).toBe(HUMAN)
    expect(runAi).not.toHaveBeenCalled()
  })

  it('keeps the original if the rewrite is no better or too long', async () => {
    runAi.mockReset().mockResolvedValueOnce({ text: 'I am passionate and I leverage everything!', model: 'm' })
    expect(await polish('I am passionate about SQL!', 150)).toBe('I am passionate about SQL!')
    runAi.mockResolvedValueOnce({ text: 'word '.repeat(200), model: 'm' })
    expect(await polish('I am passionate about SQL!', 50)).toBe('I am passionate about SQL!')
  })
})

import { describe, expect, it } from 'vitest'
import { buildQuery, classifyEmail, matchApplication, nextStatus } from '@/core/gmail/rules'
import type { AppliedEntry } from '@/shared/types'
import { normalizeCompany } from '@/shared/text'

const app = (company: string, title: string, o: Partial<AppliedEntry> = {}): AppliedEntry => ({
  key: company, appId: company.slice(0, 3), company, companyNorm: normalizeCompany(company), title, jobId: '', url: '',
  dateApplied: '2026-09-20', status: 'Applied', firstReply: '', lastStatusChange: '', ...o,
})

describe('classifyEmail (ai-job-search gmail-sync phrases)', () => {
  it('reads each status', () => {
    expect(classifyEmail('Thank you for applying to Globex', 'We have received your application.')).toBe('Received')
    expect(classifyEmail('Next steps', 'Please complete your assessment on HackerRank within 5 days.')).toBe('Assessment')
    expect(classifyEmail('Interview', "We'd like to schedule a call with you next week.")).toBe('Interview')
    expect(classifyEmail('Offer', 'We are pleased to offer you the position.')).toBe('Offer')
    expect(classifyEmail('Your application', 'Unfortunately, we have decided to move forward with other candidates.')).toBe('Rejected')
  })
  it('treats conditional interview wording in an ack as an ack', () => {
    expect(classifyEmail('Application received', 'Thanks for applying! If your background is a match, we will reach out to schedule a call.')).toBe('Received')
  })
  it('returns null when nothing matches', () => {
    expect(classifyEmail('Newsletter', 'Our latest product news')).toBeNull()
  })
})

describe('nextStatus', () => {
  it('only moves forward', () => {
    expect(nextStatus('Interview', 'Received')).toEqual({ kind: 'noop' })
    expect(nextStatus('Applied', 'Interview')).toEqual({ kind: 'apply', to: 'Interview' })
  })
  it('allows Rejected from any open stage', () => {
    expect(nextStatus('Interview', 'Rejected')).toEqual({ kind: 'apply', to: 'Rejected' })
  })
  it('flags offers and conflicts', () => {
    expect(nextStatus('Interview', 'Offer').kind).toBe('offer')
    expect(nextStatus('Rejected', 'Interview').kind).toBe('conflict')
    expect(nextStatus('Offer', 'Rejected').kind).toBe('conflict')
  })
})

describe('matchApplication', () => {
  const open = [app('Globex, Inc.', 'Data Analyst I'), app('Initech', 'Data Engineer'), app('Acme Corp', 'Analyst')]
  it('matches by sender domain', () => {
    expect(matchApplication({ from: 'Recruiting <jobs@globex.com>', subject: 'Hi', body: 'Hello' }, open).entry?.company).toBe('Globex, Inc.')
  })
  it('matches ATS mail by company name in the body', () => {
    expect(matchApplication({ from: 'no-reply@greenhouse.io', subject: 'Your application', body: 'Thank you for applying to Initech.' }, open).entry?.company).toBe('Initech')
  })
  it('refuses to guess between two equal candidates', () => {
    const r = matchApplication({ from: 'no-reply@lever.co', subject: 'Update', body: 'Globex and Initech are partners.' }, open)
    expect(r.entry).toBeNull()
    expect(r.candidates).toHaveLength(2)
  })
  it('returns nothing for unrelated mail', () => {
    expect(matchApplication({ from: 'news@example.com', subject: 'Deals', body: 'Sale' }, open).entry).toBeNull()
  })
})

describe('buildQuery', () => {
  it('limits to 30 days, excludes sent mail, includes ATS senders and companies', () => {
    const q = buildQuery(['Globex', 'Initech'])
    expect(q).toMatch(/^newer_than:30d -in:sent -in:drafts/)
    expect(q).toContain('from:greenhouse.io')
    expect(q).toContain('"globex"')
  })
})

describe('reading the sheet and searching Gmail', () => {
  it('turns sheet serial numbers and US dates into ISO dates', async () => {
    const { toISODate } = await import('@/shared/text')
    expect(toISODate('46317')).toBe('2026-10-22')
    expect(toISODate('46314')).toBe('2026-10-19')
    expect(toISODate('10/22/2026')).toBe('2026-10-22')
    expect(toISODate('2026-10-22')).toBe('2026-10-22')
    expect(toISODate('')).toBe('')
  })

  it('searches for the bare company name and the newer ATS senders', () => {
    const q = buildQuery(['Flatpay ApS ', 'Infor Careers', 'KB Marketing GmbH'])
    expect(q).toContain('"flatpay"')
    expect(q).toContain('"infor"')
    expect(q).toContain('"kb marketing"')
    expect(q).toContain('from:teamtailor-mail.com')
    expect(q).toContain('from:pinpoint.email')
  })

  it('reads common acknowledgment wording as Received', () => {
    expect(classifyEmail('Maazin x Alan', 'Thank you for showing interest in joining Alan, our team will make sure to review your application.')).toBe('Received')
    expect(classifyEmail('Thank you for your application to Mujin', 'We have successfully received your application, and our team is reviewing your background.')).toBe('Received')
  })
})


describe('rejections in the words companies use', () => {
  // Sentences from real rejection emails. Each also says "thank you for applying",
  // which used to win and mark them Received.
  const rejections: [string, string][] = [
    ['Thank You for Your Interest in The Home Depot', 'Thank you for applying for the Software Engineer position with The Home Depot. After careful consideration, we will not be moving you forward in the selection process.'],
    ['Amazon application: Status update', 'Thank you for your application for the position of Software Development Engineer. After careful consideration, we have decided not to progress with your application.'],
    ['Thanks for your interest in Uber', "Thanks so much for your interest in our Software Engineer I role. We've reviewed your application and unfortunately, it is not a match for this particular role."],
    ['Update: Seso', "Thank you for your application to the Software Engineer posting! Unfortunately, we won't be moving forward at this time."],
    ['Update on your application with McKinsey & Company', 'Unfortunately, after reviewing your application carefully, we have made the difficult decision to not move forward with your candidacy at this time.'],
    ['ESET Feedback', 'Unfortunately, after careful consideration of your work profile, we decided to continue in the recruitment process with candidates who meet our requirements better.'],
    ['UnitedHealth Group update', 'Unfortunately, the opening for this specific position is no longer available at this time.'],
    ['Update on your application at Wayve', "We've reviewed your application in detail, and on this occasion we won't be moving forward."],
    ['Maazin - Thank you for your interest', 'After careful consideration, we’ve decided not to move forward with your candidacy for this particular position.'],
    ['Thank you for your interest in Eurofins', 'Please be assured your candidacy was given full consideration; however, we have chosen to move forward with other candidates.'],
    ['Your application', 'We regret to let you know that you have not been selected for this role.'],
  ]
  it.each(rejections)('reads "%s" as Rejected', (subject, body) => {
    expect(classifyEmail(subject, body)).toBe('Rejected')
  })

  it('leaves acknowledgments and conditional warnings alone', () => {
    expect(classifyEmail('Thank you for applying', 'We will review your application alongside other candidates and contact candidates whose experience best matches the role.')).toBe('Received')
    expect(classifyEmail('Complete your assessment', 'If you do not complete the online assessment, we will not be able to move forward with your application.')).toBe('Assessment')
    expect(classifyEmail('Application received', 'Candidates not selected will be notified by email. Thank you for applying.')).toBe('Received')
  })
})

describe('buildQueries', () => {
  it('searches every company, not only the first 40', async () => {
    const { buildQueries } = await import('@/core/gmail/rules')
    const names = Array.from({ length: 70 }, (_, i) => `Company${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`)
    const qs = buildQueries(names, 45)
    expect(qs).toHaveLength(3)
    expect(qs[0]).toMatch(/^newer_than:45d /)
    expect(qs[0]).toContain('from:greenhouse.io')
    expect(qs[2]).not.toContain('from:greenhouse.io')
    expect(qs.join(' ')).toContain(`"${names[69].toLowerCase()}"`)
  })
})

describe('applications found in email', async () => {
  const { discoverApplication, sameCompany, buildDiscoveryQuery } = await import('@/core/gmail/rules')
  const found = (from: string, subject: string, body = 'Thank you for your application for this position.', status: 'Received' | 'Rejected' = 'Received') =>
    discoverApplication({ from, subject, body }, status)

  it('names the employer from the subject or the sender', () => {
    expect(found('Branden Smith <b@contextlabs.com>', 'Thank you for your interest in Context Labs', 'we regret to inform you that we will pursue other candidates for the position', 'Rejected')?.company).toBe('Context Labs')
    expect(found('Lenovo Talent Acquisition <ta@lenovo.com>', 'Jobs at Lenovo', 'we are moving forward with other candidates for the role', 'Rejected')?.company).toBe('Lenovo')
    expect(found('P&G Workday System <pg@myworkday.com>', 'P&G Careers – Application Outcome', 'We regret to inform you that you have not been chosen for this position', 'Rejected')).toMatchObject({ company: 'P&G', ats: 'Workday' })
    expect(found('Do Not Reply <noreply@mtdproducts.com>', 'Update Regarding Your Application with MTD', 'After careful review of your application', 'Rejected')?.company).toBe('MTD')
    expect(found('JD <jd@zanskar.us>', 'Maazin - Thank you for your interest', "we've decided not to move forward with your candidacy for this particular position", 'Rejected')?.company).toBe('Zanskar')
    expect(found('Quora Recruiting <no-reply@quora.com>', 'Quora | Thank you for applying! | Full Stack Software Engineer')?.company).toBe('Quora')
    expect(found('no-reply <no-reply@greenhouse-mail.io>', 'Thank you for applying for AI Engineer at Cogent Labs')).toMatchObject({ company: 'Cogent Labs', title: 'AI Engineer', ats: 'Greenhouse' })
    expect(found('Wayve <no-reply@ashbyhq.com>', 'Update on your application at Wayve - ML Triaging Engineer')).toMatchObject({ company: 'Wayve', title: 'ML Triaging Engineer' })
  })

  it('leaves out what is not an application email or has no employer', () => {
    expect(found('Ivan <ivan@gmail.com>', 'Thanks for applying to Acme')).toBeNull()
    expect(found('Handshake <x@notifications.joinhandshake.com>', 'Application sent to Tech Comm')).toBeNull()
    expect(found('Ops <ops@datalabel.io>', '🥽 Upcoming AI Data Collection Opportunity – Additional Details', 'Thank you for your application to this role.')?.company).not.toBe('Additional Details')
    expect(found('Truist <careers@truist.com>', 'Invitation to apply with Truist', 'Thank you for your interest in this role.')).toBeNull()
    // A mailing service's domain isn't the employer.
    expect(found('Criteria <no-reply@criteriacorp.com>', 'Your next step', 'Thank you for applying. Your application needs a test.')).toBeNull()
    expect(found('TixTrack <no-reply@ashbyhq.com>', 'Your application to TixTrack has been received')?.company).toBe('TixTrack')
    expect(found('Prodyna <inbound@mail.prodyna.com>', 'Full Stack Developer ( Python ) - PRODYNA')?.company).toBe('PRODYNA')
    expect(found('CMU <events@cmu.edu>', 'Grad School Insights Webinar', 'Thank you for your interest in our graduate programs.')).toBeNull()
    expect(found('Acme <jobs@acme.com>', 'Hello', 'We would like to schedule a call')).toBeNull()
    expect(found('Acme <jobs@acme.com>', 'Hello', 'We have received your application.')?.company).toBe('Acme')
    expect(discoverApplication({ from: 'Acme <jobs@acme.com>', subject: 'Interview', body: 'schedule a call about the role' }, 'Interview')).toBeNull()
  })

  it('treats a name and its longer form as one employer', () => {
    expect(sameCompany('Scaleai', 'Scale AI')).toBe(true)
    expect(sameCompany('Cleoindia', 'Cleo')).toBe(true)
    expect(sameCompany('Meijer', 'Meta')).toBe(false)
    expect(buildDiscoveryQuery(30)).toContain('-from:joinhandshake.com')
  })
})

describe('real rejections the sync missed', async () => {
  const { classifyEmail, matchApplication } = await import('@/core/gmail/rules')
  const { normalizeCompany } = await import('@/shared/text')
  const row = (company: string) => ({ key: company, appId: company, company, companyNorm: normalizeCompany(company), title: '', jobId: '', url: '', dateApplied: '2026-10-10', status: 'Received' as const, firstReply: '', lastStatusChange: '' })

  it('does not find "Infor" in "regret to inform", but still finds "Scale AI" for Scaleai', () => {
    const open = [row('Infor Careers'), row('Scaleai')]
    const pg = { from: 'P&G Workday System <pgworkdaysystem.im@pg.com>', subject: 'P&G Careers – Application Outcome', body: 'We regret to inform you have not been chosen for this position.' }
    expect(matchApplication(pg, open).candidates).toEqual([])
    expect(matchApplication({ from: 'x <no-reply@ashbyhq.com>', subject: 'Thanks for applying to Scale AI', body: '' }, open).entry?.company).toBe('Scaleai')
  })

  it('reads a rejection that comes after a run of blank lines', () => {
    const body = 'Hi Maazin,\n\n\n\nThank you for your interest in Context Labs!' + '\n'.repeat(30) + 'Although your background is impressive, we regret to inform you that we have decided to pursue other candidates for the position at this time.'
    expect(classifyEmail('Thank you for your interest in Context Labs', body)).toBe('Rejected')
  })
})

describe('job alerts', async () => {
  const { classifyEmail, isJobAlert } = await import('@/core/gmail/rules')
  it('skips "a new job matching your profile" and does not read Onsite as an interview', () => {
    const body = 'Maazin, we have one new job that matches your profile\nHead of Marketing Automation\nMarketing · Copenhagen · Onsite'
    expect(isJobAlert('Flatpay ApS - one new job matching your profile', body)).toBe(true)
    expect(classifyEmail('Flatpay ApS - one new job matching your profile', body)).toBeNull()
    expect(isJobAlert('Thanks for applying to Flatpay', 'Thanks for applying for the Data Engineer role.')).toBe(false)
    expect(classifyEmail('Next steps', "We'd like to invite you to an onsite interview.")).toBe('Interview')
    // Handshake's note lists other companies' jobs; a rejection may mention a talent community.
    expect(isJobAlert("Application sent to Comtech, LLC — here's what's next", 'Your application was sent to Comtech, LLC. View application. Apply to similar jobs.', 'Handshake <hello@notifications.joinhandshake.com>')).toBe(true)
    expect(isJobAlert('Verify your candidate account', 'Click this link to confirm your email address and complete setup for your candidate account')).toBe(true)
    expect(isJobAlert('Bending Spoons—OTP code', 'Here is your code.')).toBe(true)
    expect(isJobAlert('Thank You for Your Interest in The Home Depot', 'Thank you for applying.\nWe have decided to pursue other candidates.\nJoin our talent community to hear about new openings.')).toBe(false)
  })
})

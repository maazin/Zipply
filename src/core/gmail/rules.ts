/*
 * Gmail status rules ported from ai-job-search (https://github.com/MadsLorentzen/ai-job-search)
 * ai-job-search gmail-sync.md, MIT. Modified: translated to TypeScript; the
 * phrase table drives an automatic forward-only status machine instead of a
 * batch the user approves, with conflicts and offers routed to manual review.
 */
import type { AppStatus, AppliedEntry, AtsName } from '@/shared/types'
import { findBadWord, keywordInText, normalizeCompany } from '@/shared/text'

export const STATUS_ORDER: AppStatus[] = ['Applied', 'Received', 'Assessment', 'Interview', 'Offer']

export const PHRASES: { status: AppStatus; phrases: string[] }[] = [
  {
    status: 'Rejected',
    phrases: [
      'unable to proceed',
      'moving forward with other',
      'decided not to continue',
      'decided not to move forward',
      'not to move forward',
      'will not be moving forward',
      'not be moving forward',
      'position has been filled',
      'pursue other candidates',
      'not a fit at this time',
      'regret to inform',
      'unfortunately, we',
      // German, French, Spanish, Dutch.
      'leider müssen wir',
      'leider können wir',
      'nicht weiter berücksichtigen',
      'nous ne pouvons pas donner suite',
      'lamentablemente',
      'helaas moeten wij',
    ],
  },
  { status: 'Offer', phrases: ['pleased to offer', 'extend an offer', 'offer letter', 'excited to offer', 'formal offer'] },
  {
    status: 'Interview',
    phrases: [
      'schedule a call',
      'phone screen',
      'technical interview',
      'next round',
      // Not "onsite" alone: job listings say "Copenhagen · Onsite".
      'onsite interview',
      'on-site interview',
      'final round',
      'schedule an interview',
      'availability for an interview',
      'invite you to interview',
      'like to speak with you',
      'set up a time',
    ],
  },
  {
    status: 'Assessment',
    phrases: ['online assessment', 'coding challenge', 'complete your assessment', 'take-home', 'hackerrank', 'codility', 'codesignal', 'assessment invitation'],
  },
  {
    status: 'Received',
    phrases: [
      'received your application',
      'thank you for applying',
      'thanks for applying',
      'application has been received',
      'application was received',
      'we got your application',
      'application received',
      'thank you for your interest',
      'thanks for your interest',
      'thank you for showing interest',
      'thank you for your application',
      'thanks for your application',
      'we have received your',
      "we've received your",
      'successfully received',
      'reviewing your application',
      'review your application',
      'application has been submitted',
      'vielen dank für deine bewerbung',
      'vielen dank für ihre bewerbung',
      'danke für deine bewerbung',
      'eingangsbestätigung',
      'merci pour votre candidature',
      'nous avons bien reçu votre candidature',
      'gracias por tu candidatura',
      'gracias por postularte',
      'bedankt voor je sollicitatie',
    ],
  },
]

/** Domains ATS mail comes from, used to build the Gmail query. */
export const ATS_SENDER_DOMAINS = [
  'greenhouse.io',
  'greenhouse-mail.io',
  'lever.co',
  'hire.lever.co',
  'myworkday.com',
  'myworkdayjobs.com',
  'ashbyhq.com',
  'icims.com',
  'smartrecruiters.com',
  'bamboohr.com',
  'jobvite.com',
  'workablemail.com',
  'workable.com',
  'teamtailor-mail.com',
  'teamtailor.com',
  'pinpoint.email',
  'pinpointhq.com',
  'recruitee.com',
  'personio.de',
  'personio.com',
  'breezy.hr',
  'applytojob.com',
  'jazz.co',
  'rippling.com',
  'taleo.net',
  'successfactors.com',
  'successfactors.eu',
  'recruitee-mail.com',
]

/** Titles saved from a page that only said "Apply": they name no job, so they never match. */
const GENERIC_TITLE = /^(apply|apply now|application|job application|careers?|jobs?|job|position|role|opening|untitled)$/i

/** The job title as whole words in the email ("apply" is not in "applying"). */
export function titleIn(title: string, text: string): boolean {
  const t = title.trim()
  return t.length >= 4 && !GENERIC_TITLE.test(t) && keywordInText(t, text)
}

const GENERIC_LABELS = /^(no-?reply|do-?not-?reply|notifications?|mail|email|hire|jobs|careers|recruiting|talent|us|eu|uk|ca|au|app|www|info|hello)$/

/**
 * The company an ATS email names in its address: "flatpay.teamtailor-mail.com"
 * (a subdomain) or "chewy@myworkday.com" (Workday's sender name).
 */
function atsCompany(from: string): string {
  const m = from.match(/([\w.+-]+)@([\w.-]+)/)
  if (!m) return ''
  const local = m[1].toLowerCase()
  const domain = m[2].toLowerCase()
  const ats = ATS_SENDER_DOMAINS.find((d) => domain === d || domain.endsWith('.' + d))
  if (!ats) return ''
  const sub = domain === ats ? '' : domain.slice(0, -ats.length - 1).split('.')[0]
  if (sub && !GENERIC_LABELS.test(sub)) return normalizeCompany(sub.replace(/-/g, ' '))
  // The sender name: "chewy@myworkday.com", "epeconsulting+autoreply@talent.icims.com",
  // "job.kcm8v.fpsouc.kbmarketinggmbh1@recruitee-mail.com".
  const name = local.split('+')[0].split('.').pop()!.replace(/\d+$/, '')
  return name.length >= 3 && !GENERIC_LABELS.test(name) ? normalizeCompany(name.replace(/[_-]+/g, ' ')) : ''
}

/**
 * A job alert or "jobs matching your profile" mail from a company you applied to:
 * it says nothing about your application, and its listings read like interview
 * ("Onsite") or offer ("what we offer") wording.
 */
const JOB_ALERT = /\b(new jobs? (?:that )?match(?:es|ing)?|jobs? (?:matching|that match(?:es)?) your profile|job alerts?|recommended jobs?|jobs? (?:you may|you might|we think you(?:'|’)ll) (?:like|be interested in)|we have (?:\w+ ){0,2}new jobs?|job digest)\b/i

/** Job boards' "application sent" notes list other companies' jobs under "Apply to similar jobs". */
const BOARD_LISTING = /\b(?:apply to )?similar jobs\b|\bjobs you may (?:like|be interested in)\b/i

/** Account mail from a careers site: a link to verify, a code, a password reset. */
const ACCOUNT_MAIL = /\b(verify your (?:\w+ )?(?:account|email)|confirm your (?:email|identity)|activate your (?:\w+ )?account|verification code|one[- ]time (?:pass)?code|otp code|reset your password|password reset|sign[- ]in code)\b/i

/** Mail that says nothing about an application's status, for the rules or the AI. */
export function isJobAlert(subject: string, body: string, from = ''): boolean {
  if (ACCOUNT_MAIL.test(subject)) return true
  if (/@([\w-]+\.)*(joinhandshake|linkedin|indeed|ziprecruiter|glassdoor)\.com\b/i.test(from) && (/^application sent to\b/i.test(subject) || BOARD_LISTING.test(body))) return true
  return JOB_ALERT.test(subject) || JOB_ALERT.test(body.split(/\n/).filter((l) => l.trim()).slice(0, 3).join(' '))
}

/**
 * Classify by the signal phrase in the subject or the first lines of the body
 * (a phrase deep in a forwarded thread or footer is not a signal).
 */
export function classifyEmail(subject: string, body: string): AppStatus | null {
  // 25 lines of text: some senders (BambooHR) put a dozen blank lines between paragraphs.
  const head = `${subject}\n${body.split(/\n/).filter((l) => l.trim()).slice(0, 25).join('\n')}`.slice(0, 4000)
  const sentences = head.split(/(?<=[.!?])\s+|\n+/)
  // Rejections are worded many ways and usually open with "thank you for applying",
  // which would otherwise read as Received.
  if (sentences.some((s) => REJECTION.some((r) => r.test(s)) && !IF_NOT.test(s))) return 'Rejected'
  for (const { status, phrases } of PHRASES) {
    const hits = sentences.filter((s) => findBadWord(s, phrases))
    if (!hits.length) continue
    // "If your background fits, we'll reach out to schedule a call" is an ack, not an invite.
    if (status !== 'Rejected' && status !== 'Received' && hits.every((s) => CONDITIONAL.test(s))) continue
    return status
  }
  return null
}

/**
 * Rejection wording beyond the fixed phrases, from real emails: "we will not be
 * moving you forward", "won't be moving forward", "decided not to progress with
 * your application", "to not move forward with your candidacy", "it is not a match
 * for this particular role", "candidates who meet our requirements better", "the
 * opening is no longer available".
 */
const REJECTION: RegExp[] = [
  /(?:\bnot|n['’]t|\bunable to|\bno longer)\s+(?:(?:be|to|able|going|currently|further)\s+){0,3}(?:mov(?:e|ing)\s+(?:you\s+|your (?:application|candidacy|profile)\s+)?forward|proceed(?:ing)?\b|progress(?:ing)?\b|advanc(?:e|ing)\b)/i,
  /\b(?:have|has|were|was|are|be) not (?:been )?selected\b/i,
  // "this time we did not select you for further consideration".
  /\b(?:did|do|will|could|can)(?: not|n['’]t) (?:select|choose|shortlist|progress) you\b/i,
  /\bnot (?:a|the right|an? (?:good|strong|perfect))\s+(?:match|fit)\b/i,
  /\b(?:forward|proceed|proceeding|continue|continuing|pursue|pursuing|selected|chosen|chose|go|going) (?:with )?(?:\w+ ){0,2}(?:other|another|a different|stronger|more qualified) (?:candidates?|applicants?|individuals?)\b/i,
  /\b(?:with|selected|chosen|chose|hired|other)\s+(?:\w+\s+){0,2}candidates?\s+(?:who|whose)\b[^.]{0,80}\b(?:more closely|better|closer|best)\b/i,
  /\b(?:position|role|opening|requisition|job|vacancy)\b[^.]{0,60}\b(?:no longer (?:available|open)|has been (?:filled|closed|cancell?ed)|is now (?:filled|closed))\b/i,
  /\bwill not be (?:considered|offered)\b/i,
  // "No interview for Data Scientist"; "we wish you much success in your career search".
  /^no interview\b/i,
  /\bwish you (?:\w+ ){0,3}(?:success|luck|the best)\b[^.]{0,40}\b(?:search|future|endeavou?rs?|career)\b/i,
  /\b(?:decided|chosen|chose) to (?:go|move|proceed|continue) (?:in a different direction|with (?:another|other|a different))\b/i,
  /\bregret (?:to (?:inform|let you know|say|tell)|that we)\b/i,
]

/** "If you don't complete the assessment, we can't move forward": a warning, not a rejection. */
const IF_NOT = /\b(if|unless|until|without|once|in order to)\b/i

const CONDITIONAL = /\b(if|should|may|might|once|in the event|will be in touch|will reach out|reach out to you|will contact|we('|’)ll contact)\b/i

export type Transition =
  | { kind: 'apply'; to: AppStatus }
  | { kind: 'noop' }
  | { kind: 'conflict'; reason: string }
  | { kind: 'offer'; to: 'Offer' }

/**
 * Status only moves forward (Applied → Received → Assessment → Interview → Offer),
 * except Rejected, which can follow any stage. A change against a final status
 * (Offer or Rejected) goes to manual review; an Offer is flagged for a decision.
 */
export function nextStatus(current: AppStatus, signal: AppStatus): Transition {
  if (signal === current) return { kind: 'noop' }
  const final = current === 'Offer' || current === 'Rejected'
  if (final) return { kind: 'conflict', reason: `Email says ${signal} but the application is already ${current}` }
  if (signal === 'Rejected') return { kind: 'apply', to: 'Rejected' }
  if (signal === 'Offer') return { kind: 'offer', to: 'Offer' }
  const from = STATUS_ORDER.indexOf(current)
  const to = STATUS_ORDER.indexOf(signal)
  return to > from ? { kind: 'apply', to: signal } : { kind: 'noop' }
}

function senderDomain(from: string): string {
  const m = from.match(/@([\w.-]+)/)
  return m ? m[1].toLowerCase() : ''
}

/** "careers.acme-corp.com" → "acme corp" */
function domainCompany(domain: string): string {
  if (ATS_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) return ''
  const parts = domain.split('.')
  const core = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
  return normalizeCompany(core.replace(/-/g, ' '))
}

export interface EmailParts {
  from: string
  subject: string
  body: string
}

/**
 * Match an email to one open application by normalized sender domain, company
 * name, and job title or ID in the subject or body. Ambiguous or absent → null
 * (never fabricate a match).
 */
export function matchApplication(email: EmailParts, open: AppliedEntry[]): { entry: AppliedEntry | null; candidates: AppliedEntry[]; also?: AppliedEntry[] } {
  const domainCo = domainCompany(senderDomain(email.from)) || atsCompany(email.from)
  const display = normalizeCompany(email.from.replace(/<.*>/, ''))
  const text = `${email.subject}\n${email.body}`.toLowerCase()
  const scored = open
    .map((e) => {
      const co = e.companyNorm
      if (!co) return { e, s: 0 }
      const squash = (x: string) => x.replace(/ /g, '')
      // The email has to name the company somewhere: a role title alone ("Software
      // Engineer") also appears in other companies' emails.
      let company = 0
      if (domainCo && (domainCo === co || squash(domainCo) === squash(co) || (squash(co).length >= 4 && squash(domainCo).startsWith(squash(co))))) company += 3
      if (display.length >= 3 && (display.includes(co) || co.includes(display))) company += 2
      if (new RegExp(`(^|[^a-z0-9])${co.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text)) company += 2
      // "Scaleai" in the sheet, "Scale AI" in the email: the same letters, spaced, as
      // whole words. Not inside a word: "Infor" is in "regret to inform".
      else if (squash(co).length >= 5 && spaced(squash(co)).test(text)) company += 2
      if (!company) return { e, s: 0 }
      let s = company
      if (e.jobId.length >= 5 && keywordInText(e.jobId, text)) s += 3
      if (titleIn(e.title, text)) s += 2
      return { e, s }
    })
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s)
  if (!scored.length) return { entry: null, candidates: [] }
  const top = scored.filter((x) => x.s === scored[0].s).map((x) => x.e)
  if (top.length > 1) {
    // The same job applied to twice (two rows, same company and title): the email is about both.
    const same = (a: AppliedEntry) => `${a.companyNorm}|${a.title.trim().toLowerCase()}`
    if (top.every((e) => same(e) === same(top[0]))) return { entry: top[0], candidates: top, also: top.slice(1) }
    return { entry: null, candidates: scored.map((x) => x.e) }
  }
  return { entry: scored[0].e, candidates: [scored[0].e] }
}

/** "scaleai" → matches "scale ai", "scale-ai" and "scaleai"; "cleoindia" → "cleo (india)". Whole words. */
function spaced(word: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${[...word].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]{0,2}')}([^a-z0-9]|$)`)
}

/** Gmail search query for the last 30 days (from gmail-sync.md step 3). */
export function buildQuery(companies: string[], days = 30, senders = true): string {
  // The bare name ("Flatpay", not "Flatpay ApS"), which is how emails write it.
  const names = [...new Set(companies.map(normalizeCompany).filter((c) => c.length >= 2))].map((c) => `"${c}"`)
  const groups = senders ? [`{${ATS_SENDER_DOMAINS.map((d) => `from:${d}`).join(' ')}}`] : []
  if (names.length) groups.push(`{${names.join(' ')}}`)
  return `newer_than:${days}d -in:sent -in:drafts -in:spam (${groups.join(' OR ')})`
}

/** Companies per search, so a long list of applications isn't cut off at the first 40. */
const NAMES_PER_QUERY = 30

/** One search for ATS senders and the first companies, then one per further batch of companies. */
export function buildQueries(companies: string[], days = 30): string[] {
  const names = [...new Set(companies.map(normalizeCompany).filter((c) => c.length >= 2))]
  const out = [buildQuery(names.slice(0, NAMES_PER_QUERY), days)]
  for (let i = NAMES_PER_QUERY; i < names.length; i += NAMES_PER_QUERY) out.push(buildQuery(names.slice(i, i + NAMES_PER_QUERY), days, false))
  return out
}

// ---------- Applications made outside Zipply ----------

/** Personal mail and job boards: the sender doesn't name the employer, or the board logs it. */
const NOT_EMPLOYER = /(^|\.)(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail|joinhandshake|linkedin|indeed|glassdoor|ziprecruiter|wellfound|substack|climatebase)\.[a-z.]+$/

/**
 * Hiring and mailing services that send for an employer: their domain is not the
 * employer's name ("inbound@…", "kajabimail", "hibob", an assessment vendor).
 */
const MAILERS = /(^|\.)(comeet|comeet-notifications|hibob|criteriacorp|kajabimail|mailgun|sendgrid|mandrillapp|amazonses|jobylon|join|homerun|freshteam|zohorecruit|manatal|dover|paylocity|paycomonline|ultipro|ukg|oraclecloud|taleo|successfactors|eightfold|phenom|avature|factorialhr|arcoro|hackerrank|codility|codesignal|hirevue|mailchimp|hubspot)\.[a-z.]+$|^(inbound|mail|email|notifications?|noreply|no-reply)\./

const ATS_NAMES: [RegExp, AtsName][] = [
  [/ashbyhq\.com$/, 'Ashby'],
  [/greenhouse(-mail)?\.io$/, 'Greenhouse'],
  [/lever\.co$/, 'Lever'],
  [/myworkday(jobs)?\.com$/, 'Workday'],
  [/icims\.com$/, 'iCIMS'],
  [/smartrecruiters\.com$/, 'SmartRecruiters'],
]

/** "Thanks for applying to Boosters", "your application at Wayve - ML Engineer", "Jobs at Lenovo", "P&G Careers – Application Outcome". */
const SUBJECT_COMPANY: RegExp[] = [
  /\b(?:applying|applied|application|apply|interest)\s+(?:to|in|with)\s+(?:join(?:ing)?\s+)?(?:the\s+)?(.+?)\s*(?:[!|:–—?]|\s-\s|\s+(?:has|have|was|is|as)\b|\s+for\s+(?:the|a|an|our|this|your)\b|$)/i,
  /\bat\s+(.+?)\s*(?:[!|:–—?]|\s-\s|\s+(?:has|have|was|is|as)\b|\s+for\s+(?:the|a|an|our|this|your)\b|$)/i,
  /^(.+?)\s+(?:careers|recruiting|hiring)\b/i,
  /^(.+?)\s*\|\s*(?:thank|thanks|your application|application)/i,
  // "Full Stack Developer (Python) - PRODYNA": the role, then the company.
  /\s[-–—]\s+([A-Z][\w&.' ]{1,38})$/,
]

/** An invitation or a job alert, not an application you made. */
const NOT_APPLIED = /\b(invitation to apply|invite you to apply|invited to apply|apply now|jobs? (?:for you|alert|recommendations?)|recommended jobs|new jobs?|we'?re hiring|is hiring)\b/i

/** What a captured company can't be: a role, a pronoun, a phrase. */
const NOT_COMPANY = /^(us|our team|the team|this role|the role|the position|this position|joining|working|a |an |the |your |our )|\b(engineer|developer|analyst|intern(ship)?|position|role|scientist|manager|designer|candidate|thanks?|thank you|application|interest|update|regarding|next steps?|details|opportunit(?:y|ies)|information|reminder|invitation|confirmation|offer)s?\b/i

/** Words that make a sender name a team rather than a person: "Lenovo Talent Acquisition". */
const TEAM_WORDS = /\s*\b(talent acquisition|hiring team|recruiting team|recruitment team|recruiting|recruitment|careers|hiring|talent|team|hr|people)\b.*$/i

/** About a job application, not a webinar or a grad-school "application". */
const JOB_CONTEXT = /\b(your (?:job )?application|your candidacy|for applying|you applied|application (?:for|to|at|with)|(?:the|this) (?:[\w-]+ ){0,4}(?:position|role|opening)|job)\b/i

/** A mailbox, not a name: "no-reply-…", "notifications". */
const MAILBOX = /^(no-?reply|do-?not-?reply|noreply|notifications?|mailer|postmaster|bounce)\b/i

function cleanCompany(s: string): string {
  // "the Center for Energy and Environment" is the Center for Energy and Environment.
  // "Notion's" (as in "Notion's hiring team") is Notion.
  const c = s.replace(/['’]s$/i, '').replace(/[\s.,;'"“”’-]+$/, '').replace(/^[\s'"“”]+/, '').replace(/^the\s+(?=[A-Z])/, '').trim()
  return c.length >= 2 && c.length <= 40 && !NOT_COMPANY.test(c) && !MAILBOX.test(c) && normalizeCompany(c).length >= 2 ? c : ''
}

const capitalize = (s: string) => s.replace(/^\w/, (c) => c.toUpperCase())

function senderName(from: string): string {
  return from.replace(/<.*>/, '').replace(/"/g, '').trim()
}

export interface Discovered {
  company: string
  title: string
  ats: AtsName
}

/**
 * An application this email is about, made without Zipply: a confirmation or a
 * rejection whose sender or subject names the company. Null when it isn't clearly
 * an application email or the employer can't be told.
 */
export function discoverApplication(email: EmailParts, status: AppStatus | null, how: { labeled?: boolean; sent?: boolean } = {}): Discovered | null {
  // In your own "Applied" label, the label says it's an application; otherwise the email has to.
  if (status !== 'Received' && status !== 'Rejected' && !(how.labeled && (status === null || status === 'Applied'))) return null
  // An email you sent: the employer is who it went to (pass its To as "from").
  const domain = senderDomain(email.from)
  if (!domain || NOT_EMPLOYER.test(domain)) return null
  const head = `${email.subject}\n${email.body.split(/\n/).filter((l) => l.trim()).slice(0, 25).join('\n')}`
  if ((!how.labeled && !JOB_CONTEXT.test(head)) || NOT_APPLIED.test(email.subject)) return null
  const mailer = MAILERS.test(domain)

  let company = ''
  // Your own subject line names the role and you ("Junior Engineer - Maazin Shaikh"), not the employer.
  if (!how.sent)
    for (const re of SUBJECT_COMPANY) {
      const m = email.subject.match(re)
      if (m && (company = cleanCompany(m[1]))) break
    }
  const team = senderName(email.from)
  if (!company && !how.sent && TEAM_WORDS.test(team)) company = cleanCompany(team.replace(TEAM_WORDS, ''))
  // A domain name ("homedepot") only when it's the employer's own.
  if (!company && !mailer) company = cleanCompany(capitalize(domainCompany(domain) || atsCompany(email.from)))
  if (!company) return null

  const title = email.subject.match(/\b(?:applying|application|applied) for (?:the )?(?:(?:position|role) of )?(.+?)(?:\s+(?:at|with|position|role)\b|[!|:–—]|\s-\s|$)/i)?.[1] ?? email.subject.match(/\sat\s+.+?\s-\s+(.+)$/i)?.[1] ?? ''
  return { company, title: how.sent ? '' : title.trim(), ats: ATS_NAMES.find(([re]) => re.test(domain))?.[1] ?? 'Other' }
}

/** One name is the other, or begins it ("Cleo" and "Cleo India"); for rows that might be the same employer. */
export function sameCompany(a: string, b: string): boolean {
  const x = normalizeCompany(a).replace(/ /g, '')
  const y = normalizeCompany(b).replace(/ /g, '')
  if (!x || !y) return false
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)))
}

/** Confirmations and rejections from anyone, for applications the sheet doesn't have yet. */
export function buildDiscoveryQuery(days: number): string {
  const phrases = ['thank you for applying', 'thanks for applying', 'your application', 'your candidacy', 'regret to inform', 'other candidates', 'thank you for your interest', 'application received']
  return `newer_than:${days}d -in:sent -in:drafts -in:spam -from:joinhandshake.com -from:linkedin.com {${phrases.map((p) => `"${p}"`).join(' ')}}`
}

/** Your own labels for applications ("Applications/Applied", "Applied"). */
export const APPLIED_LABEL = /(^|\/)\s*(applied|job applications?)\s*$/i

/** Everything under those labels, your sent applications included. */
export function buildLabelQuery(labels: string[], days: number): string {
  // Gmail's form of a label name: "Applications/Applied" → applications-applied.
  const names = labels.map((l) => `label:${l.toLowerCase().replace(/[\s/]+/g, '-')}`)
  return `newer_than:${days}d -in:drafts -in:spam {${names.join(' ')}}`
}

/**
 * Words that make an email worth a look when the rules can't read it: it may be a
 * decision or a next step. Anything else from a company (a newsletter, a survey,
 * a recruiter's note) needs nothing from you.
 */
const MIGHT_MATTER = /\b(interview|assessment|offer|unfortunately|regret|next steps?|schedul\w*|availability|move forward|moving forward|not (?:been )?selected|other candidates|position (?:has been|was) filled|decision)\b/i

export function mightMatter(subject: string, body: string): boolean {
  return MIGHT_MATTER.test(`${subject}\n${body.split(/\n/).filter((l) => l.trim()).slice(0, 25).join('\n')}`)
}

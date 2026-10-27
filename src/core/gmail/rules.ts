/*
 * Gmail status rules ported from ai-job-search (https://github.com/MadsLorentzen/ai-job-search)
 * ai-job-search gmail-sync.md, MIT. Modified: translated to TypeScript; the
 * phrase table drives an automatic forward-only status machine instead of a
 * batch the user approves, with conflicts and offers routed to manual review.
 */
import type { AppStatus, AppliedEntry } from '@/shared/types'
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
      'onsite',
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
function titleIn(title: string, text: string): boolean {
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
 * Classify by the signal phrase in the subject or the first lines of the body
 * (a phrase deep in a forwarded thread or footer is not a signal).
 */
export function classifyEmail(subject: string, body: string): AppStatus | null {
  const head = `${subject}\n${body.split(/\n/).slice(0, 25).join('\n')}`.slice(0, 4000)
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
  /\bnot (?:a|the right|an? (?:good|strong|perfect))\s+(?:match|fit)\b/i,
  /\b(?:forward|proceed|proceeding|continue|continuing|pursue|pursuing|selected|chosen|chose|go|going) (?:with )?(?:\w+ ){0,2}(?:other|another|a different|stronger|more qualified) (?:candidates?|applicants?|individuals?)\b/i,
  /\b(?:with|selected|chosen|chose|hired|other)\s+(?:\w+\s+){0,2}candidates?\s+(?:who|whose)\b[^.]{0,80}\b(?:more closely|better|closer|best)\b/i,
  /\b(?:position|role|opening|requisition|job|vacancy)\b[^.]{0,60}\b(?:no longer (?:available|open)|has been (?:filled|closed|cancell?ed)|is now (?:filled|closed))\b/i,
  /\bwill not be (?:considered|offered)\b/i,
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
      // "Scaleai" in the sheet, "Scale AI" in the email.
      else if (squash(co).length >= 5 && squash(text.replace(/[^a-z0-9]+/g, ' ')).includes(squash(co))) company += 2
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

/** Gmail search query for the last 30 days (from gmail-sync.md step 3). */
export function buildQuery(companies: string[], days = 30, senders = true): string {
  // The bare name ("Flatpay", not "Flatpay ApS"), which is how emails write it.
  const names = [...new Set(companies.map(normalizeCompany).filter((c) => c.length >= 2))].map((c) => `"${c}"`)
  const groups = senders ? [`{${ATS_SENDER_DOMAINS.map((d) => `from:${d}`).join(' ')}}`] : []
  if (names.length) groups.push(`{${names.join(' ')}}`)
  return `newer_than:${days}d -in:sent -in:drafts (${groups.join(' OR ')})`
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

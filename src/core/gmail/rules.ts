/*
 * Gmail status rules ported from ai-job-search (https://github.com/MadsLorentzen/ai-job-search)
 * ai-job-search gmail-sync.md, MIT. Modified: translated to TypeScript; the
 * phrase table drives an automatic forward-only status machine instead of a
 * batch the user approves, with conflicts and offers routed to manual review.
 */
import type { AppStatus, AppliedEntry } from '@/shared/types'
import { findBadWord, normalizeCompany } from '@/shared/text'

export const STATUS_ORDER: AppStatus[] = ['Applied', 'Received', 'Assessment', 'Interview', 'Offer']

export const PHRASES: { status: AppStatus; phrases: string[] }[] = [
  {
    status: 'Rejected',
    phrases: [
      'not selected',
      'unable to proceed',
      'other candidates',
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
]

/**
 * Classify by the signal phrase in the subject or the first lines of the body
 * (a phrase deep in a forwarded thread or footer is not a signal).
 */
export function classifyEmail(subject: string, body: string): AppStatus | null {
  const head = `${subject}\n${body.split(/\n/).slice(0, 25).join('\n')}`.slice(0, 4000)
  const sentences = head.split(/(?<=[.!?])\s+|\n+/)
  for (const { status, phrases } of PHRASES) {
    const hits = sentences.filter((s) => findBadWord(s, phrases))
    if (!hits.length) continue
    // "If your background fits, we'll reach out to schedule a call" is an ack, not an invite.
    if (status !== 'Rejected' && status !== 'Received' && hits.every((s) => CONDITIONAL.test(s))) continue
    return status
  }
  return null
}

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
export function matchApplication(email: EmailParts, open: AppliedEntry[]): { entry: AppliedEntry | null; candidates: AppliedEntry[] } {
  const domainCo = domainCompany(senderDomain(email.from))
  const display = normalizeCompany(email.from.replace(/<.*>/, ''))
  const text = `${email.subject}\n${email.body}`.toLowerCase()
  const scored = open
    .map((e) => {
      let s = 0
      const co = e.companyNorm
      if (!co) return { e, s }
      const squash = (x: string) => x.replace(/ /g, '')
      if (domainCo && (domainCo === co || squash(domainCo) === squash(co))) s += 3
      if (display && (display.includes(co) || co.includes(display))) s += 2
      if (new RegExp(`(^|[^a-z0-9])${co.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text)) s += 2
      if (e.jobId && text.includes(e.jobId.toLowerCase())) s += 3
      if (e.title && text.includes(e.title.toLowerCase())) s += 2
      return { e, s }
    })
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s)
  if (!scored.length) return { entry: null, candidates: [] }
  if (scored.length > 1 && scored[0].s === scored[1].s) return { entry: null, candidates: scored.map((x) => x.e) }
  return { entry: scored[0].e, candidates: [scored[0].e] }
}

/** Gmail search query for the last 30 days (from gmail-sync.md step 3). */
export function buildQuery(companies: string[], days = 30): string {
  const names = [...new Set(companies.filter(Boolean))].slice(0, 40).map((c) => `"${c.replace(/"/g, '')}"`)
  const senders = ATS_SENDER_DOMAINS.map((d) => `from:${d}`).join(' ')
  const groups = [`{${senders}}`]
  if (names.length) groups.push(`{${names.join(' ')}}`)
  return `newer_than:${days}d -in:sent -in:drafts (${groups.join(' OR ')})`
}

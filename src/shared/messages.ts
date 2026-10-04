import type {
  AnswerBankEntry,
  AppliedCheck,
  AtsName,
  FieldKind,
  FieldReport,
  MatchResult,
  Posting,
  Profile,
  RedFlagResult,
  VerdictResult,
} from './types'
import type { MapField } from '@/core/ai/prompts'

/** What the panel knows about the job in a tab. Kept in session storage per tab. */
export interface JobContext {
  posting: Posting
  ats: AtsName
  resumeId: string | null
  resumeTag: string
  match: MatchResult | null
  verdict: VerdictResult | null
  redFlags: RedFlagResult | null
  applied: AppliedCheck | null
  filledAt?: number
  loggedAppId?: string
}

export interface FrameInfo {
  frameId: number
  ats: AtsName
  fields: number
  confirmation: boolean
  url: string
}

export interface FillContext {
  profile: Profile
  bank: AnswerBankEntry[]
  resume: { id: string; name: string; mime: string; data: string } | null
  threshold: number
  autoDraft: boolean
  aiReady: boolean
  posting: Posting | null
}

export interface ScanResult {
  ats: AtsName
  fields: number
  confirmation: boolean
  posting: Posting | null
}

export interface LogResult {
  ok: boolean
  appId?: string
  duplicate?: boolean
  queued?: boolean
  error?: string
}

export interface AiText {
  text: string
  warnings: string[]
  model: string
}

// Content script → service worker
export type ContentToBg =
  | { type: 'frame:status'; ats: AtsName; fields: number; confirmation: boolean; posting: Posting | null }
  | { type: 'fill:context'; resumeId: string | null }
  | { type: 'answer:save'; label: string; answer: string; fieldKind: FieldKind; host: string; source: 'typed' | 'ai' }
  | { type: 'answer:used'; id: string }
  | { type: 'ai:map'; fields: MapField[] }
  | { type: 'ai:answer'; question: string; maxWords: number }
  | { type: 'submit:confirmed'; ats: AtsName; url: string; posting: Posting | null }
  | { type: 'fill:done'; reports: FieldReport[]; auto: boolean }

// Panel / options → service worker
export type PageToBg =
  | { type: 'tab:state'; tabId: number }
  | { type: 'job:set'; tabId: number; job: JobContext }
  | { type: 'log:manual'; tabId: number }
  | { type: 'ai:cover'; tabId: number }
  | { type: 'ai:tips'; tabId: number }
  | { type: 'google:connect' }
  | { type: 'google:disconnect' }
  | { type: 'gmail:enable'; enabled: boolean }
  | { type: 'gmail:sync' }
  | { type: 'gmail:message'; messageId: string }
  | { type: 'status:assign'; messageId: string; appId: string; status: string }
  | { type: 'queue:flush' }
  | { type: 'applied:refresh' }

// Panel → content script
export type PageToContent =
  | { type: 'scan' }
  | { type: 'fill'; resumeId: string | null }
  | { type: 'focus'; zid: string }
  | { type: 'insert'; text: string; target: 'cover-letter' }
  | { type: 'stop' }

export type Msg = ContentToBg | PageToBg

export function send<T = unknown>(msg: Msg): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>
}

export function sendToFrame<T = unknown>(tabId: number, frameId: number, msg: PageToContent): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg, { frameId }) as Promise<T>
}

/** Errors cross message boundaries as { error } objects. */
export interface ErrorReply {
  error: string
  locked?: boolean
}

export function isError<T>(x: T): x is Extract<T, { error: string }> {
  return typeof x === 'object' && x !== null && 'error' in x
}

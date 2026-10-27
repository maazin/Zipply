import type { AppStatus, Posting, Profile } from '@/shared/types'
import type { AiText } from '@/shared/messages'
import { PROFILE_KEYS } from '@/shared/profileKeys'
import {
  answerPrompt,
  coverLetterPlanPrompt,
  coverLetterPrompt,
  frameLetter,
  LETTER_WORDS,
  letterExpandPrompt,
  type LetterPlan,
  emailClassifyPrompt,
  fieldMapPrompt,
  groundingPrompt,
  tailoringPrompt,
  type MapField,
} from '@/core/ai/prompts'
import { revisionPrompt, styleIssues, tidy } from '@/core/ai/style'
import { runAi, runAiJson } from './router'

/** Labels in, profile key names out. No personal values are sent. */
export async function mapFields(fields: MapField[]): Promise<{ id: string; key: string }[]> {
  if (!fields.length) return []
  const { system, prompt, schema } = fieldMapPrompt(fields)
  const r = await runAiJson<{ mappings: { id: string; key: string }[] }>('map', system, prompt, schema)
  const allowed = new Set<string>(PROFILE_KEYS)
  const ids = new Set(fields.map((f) => f.id))
  // Only keys from the fixed list survive, whatever the model says.
  return (r?.data.mappings ?? []).filter((m) => ids.has(m.id) && allowed.has(m.key))
}

/** Second pass: flag claims the draft makes that the profile doesn't support. */
async function ground(draft: string, profile: Profile): Promise<string[]> {
  const { system, prompt, schema } = groundingPrompt(draft, profile)
  const r = await runAiJson<{ unsupported: string[] }>('check', system, prompt, schema)
  return (r?.data.unsupported ?? []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 5)
}

/**
 * Clean up a draft so it reads like a person wrote it: mechanical fixes first,
 * then one rewrite if chatbot habits remain. The rewrite is kept only if it's
 * cleaner and still within the length limit.
 */
export async function polish(draft: string, maxWords: number, opts: { bullets?: boolean } = {}): Promise<string> {
  const first = tidy(draft, opts)
  const issues = styleIssues(first, opts)
  if (!issues.length) return first
  const { system, prompt } = revisionPrompt(first, issues, maxWords)
  const r = await runAi('write', system, prompt)
  if (!r) return first
  const second = tidy(r.text, opts)
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length
  return second && styleIssues(second, opts).length < issues.length && words(second) <= Math.ceil(maxWords * 1.15) ? second : first
}

export async function draftAnswer(question: string, posting: Posting | null, profile: Profile, maxWords = 150): Promise<AiText | null> {
  const { system, prompt } = answerPrompt(question, posting, profile, maxWords)
  const r = await runAi('write', system, prompt)
  if (!r) return null
  const text = await polish(r.text, maxWords)
  return { text, warnings: await ground(text, profile), model: r.model }
}

const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length

/**
 * Plan, write, clean up, and lengthen once if it came back short. The plan
 * picks the hook and the evidence first, so the letter argues something
 * specific instead of listing skills. Returns the letter with its greeting and
 * sign-off; only the body is checked against your profile.
 */
export async function coverLetter(posting: Posting, profile: Profile): Promise<AiText | null> {
  const p = coverLetterPlanPrompt(posting, profile)
  const plan = (await runAiJson<LetterPlan>('write', p.system, p.prompt, p.schema))?.data
  const usable = plan && typeof plan.hook === 'string' && Array.isArray(plan.matches) ? plan : null
  const { system, prompt } = coverLetterPrompt(posting, profile, usable)
  const r = await runAi('write', system, prompt)
  if (!r) return null
  let body = await polish(r.text, LETTER_WORDS.max + 40)
  if (wordCount(body) < LETTER_WORDS.min - 50) {
    const e = letterExpandPrompt(body, posting, profile)
    const longer = await runAi('write', e.system, e.prompt)
    const text = longer ? await polish(longer.text, LETTER_WORDS.max + 40) : ''
    if (wordCount(text) > wordCount(body) && styleIssues(text).length <= styleIssues(body).length) body = text
  }
  return { text: frameLetter(body, posting, profile), warnings: await ground(body, profile), model: r.model }
}

export async function tailoringTips(posting: Posting, bullets: string, missing: string[]): Promise<AiText | null> {
  if (!missing.length) return null
  const { system, prompt } = tailoringPrompt(posting, bullets, missing)
  const r = await runAi('write', system, prompt)
  return r ? { text: await polish(r.text, 90, { bullets: true }), warnings: [], model: r.model } : null
}

/** On-device only, unless you turned on the cloud fallback for email. */
export async function classifyEmailAi(subject: string, body: string, allowCloud: boolean): Promise<AppStatus | null> {
  const { system, prompt, schema } = emailClassifyPrompt(subject, body)
  const r =
    (await runAiJson<{ status: string }>('private', system, prompt, schema)) ??
    (allowCloud ? await runAiJson<{ status: string }>('check', system, prompt, schema) : null)
  const s = r?.data.status
  return s && s !== 'Unclear' && ['Received', 'Assessment', 'Interview', 'Offer', 'Rejected'].includes(s) ? (s as AppStatus) : null
}

import type { AppStatus, Posting, Profile } from '@/shared/types'
import type { AiText } from '@/shared/messages'
import { PROFILE_KEYS } from '@/shared/profileKeys'
import {
  answerPrompt,
  coverLetterPrompt,
  emailClassifyPrompt,
  fieldMapPrompt,
  groundingPrompt,
  tailoringPrompt,
  type MapField,
} from '@/core/ai/prompts'
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

export async function draftAnswer(question: string, posting: Posting | null, profile: Profile, maxWords = 150): Promise<AiText | null> {
  const { system, prompt } = answerPrompt(question, posting, profile, maxWords)
  const r = await runAi('write', system, prompt)
  if (!r) return null
  const text = r.text.trim()
  return { text, warnings: await ground(text, profile), model: r.model }
}

export async function coverLetter(posting: Posting, profile: Profile): Promise<AiText | null> {
  const { system, prompt } = coverLetterPrompt(posting, profile)
  const r = await runAi('write', system, prompt)
  if (!r) return null
  const text = r.text.trim()
  return { text, warnings: await ground(text, profile), model: r.model }
}

export async function tailoringTips(posting: Posting, bullets: string, missing: string[]): Promise<AiText | null> {
  if (!missing.length) return null
  const { system, prompt } = tailoringPrompt(posting, bullets, missing)
  const r = await runAi('write', system, prompt)
  return r ? { text: r.text.trim(), warnings: [], model: r.model } : null
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

// Gemini Nano through Chrome's built-in Prompt API. Runs entirely on this
// laptop, so it's the only model that ever sees resume text or email content.

interface LMSession {
  prompt(input: string, opts?: { responseConstraint?: object; signal?: AbortSignal }): Promise<string>
  destroy(): void
}

interface LMStatic {
  availability(opts?: object): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>
  create(opts?: {
    initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[]
    expectedInputs?: { type: 'text'; languages?: string[] }[]
    expectedOutputs?: { type: 'text'; languages?: string[] }[]
    monitor?: (m: EventTarget) => void
  }): Promise<LMSession>
}

function lm(): LMStatic | null {
  return ((globalThis as unknown as { LanguageModel?: LMStatic }).LanguageModel ?? null) as LMStatic | null
}

const LANG = { expectedInputs: [{ type: 'text' as const, languages: ['en'] }], expectedOutputs: [{ type: 'text' as const, languages: ['en'] }] }

export type NanoStatus = 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available'

export async function nanoStatus(): Promise<NanoStatus> {
  const L = lm()
  if (!L) return 'unsupported'
  try {
    return await L.availability(LANG)
  } catch {
    return 'unavailable'
  }
}

/** Run one prompt on Nano. Returns null when Nano isn't ready on this device. */
export async function nanoPrompt(system: string, prompt: string, schema?: object, allowDownload = false): Promise<string | null> {
  const L = lm()
  if (!L) return null
  const status = await nanoStatus()
  if (status === 'unavailable' || status === 'unsupported') return null
  if (status !== 'available' && !allowDownload) return null
  const session = await L.create({ initialPrompts: [{ role: 'system', content: system }], ...LANG })
  try {
    return await session.prompt(prompt, schema ? { responseConstraint: schema } : undefined)
  } finally {
    session.destroy()
  }
}

// Gemini API, free tier only. The key comes from a Google AI Studio project with
// no billing account, so a paid call is impossible.
import { GoogleGenAI } from '@google/genai'

/**
 * Gemini said "too many requests". The free tier has a per-minute limit as well
 * as the daily one, and only the daily one means "spent until tomorrow".
 */
export class QuotaError extends Error {
  constructor(
    model: string,
    /** The daily quota, not the per-minute one. */
    readonly daily: boolean,
    /** How long Google says to wait, for a per-minute limit. */
    readonly retryMs: number,
  ) {
    super(daily ? `${model} hit its free daily limit` : `${model} is rate-limited for ${Math.round(retryMs / 1000)} s`)
    this.name = 'QuotaError'
  }
}

/** Read the quota and the wait from Gemini's error ("GenerateRequestsPerDay…", "retryDelay": "37s"). */
export function quotaFrom(model: string, msg: string): QuotaError {
  const wait = msg.match(/retry ?delay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i) ?? msg.match(/retry in (\d+(?:\.\d+)?)\s*s/i)
  return new QuotaError(model, /per ?day/i.test(msg), wait ? Math.ceil(Number(wait[1]) * 1000) : 30_000)
}

let client: { key: string; ai: GoogleGenAI } | null = null

function ai(apiKey: string): GoogleGenAI {
  if (!client || client.key !== apiKey) client = { key: apiKey, ai: new GoogleGenAI({ apiKey }) }
  return client.ai
}

export interface GeminiRequest {
  apiKey: string
  model: string
  system: string
  prompt: string
  schema?: object
  temperature?: number
}

export async function geminiGenerate(req: GeminiRequest): Promise<string> {
  try {
    const res = await ai(req.apiKey).models.generateContent({
      model: req.model,
      contents: req.prompt,
      config: {
        systemInstruction: req.system,
        temperature: req.temperature ?? 0.4,
        ...(req.schema ? { responseMimeType: 'application/json', responseJsonSchema: req.schema } : {}),
      },
    })
    const text = res.text ?? ''
    if (!text) throw new Error('Empty response')
    return text
  } catch (e) {
    const status = (e as { status?: number })?.status
    const msg = e instanceof Error ? e.message : String(e)
    if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(msg)) throw quotaFrom(req.model, msg)
    throw e
  }
}

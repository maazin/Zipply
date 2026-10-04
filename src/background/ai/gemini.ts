// Gemini API, free tier only. The key comes from a Google AI Studio project with
// no billing account, so a paid call is impossible.
import { GoogleGenAI } from '@google/genai'

export class QuotaError extends Error {
  constructor(model: string) {
    super(`${model} hit its free daily limit`)
    this.name = 'QuotaError'
  }
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
    if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(msg)) throw new QuotaError(req.model)
    throw e
  }
}

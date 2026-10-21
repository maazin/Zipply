// The last 50 errors, kept so problems can be diagnosed later. Messages are
// scrubbed of emails, phone numbers, links and keys before they're stored.
import { local } from './store'
import { withLock } from './lock'

export interface ErrorEntry {
  at: number
  where: string
  message: string
}

const KEY = 'errlog'
const MAX = 50

export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/AIza[\w-]{20,}/g, '[key]')
    .replace(/ya29\.[\w.-]+/g, '[token]')
    .replace(/(Bearer|key=|token=)\s*[\w.-]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"')]+/g, (u) => u.split(/[?#]/)[0])
    .replace(/(\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[phone]')
    .slice(0, 500)
}

export async function logError(where: string, e: unknown): Promise<void> {
  const message = scrub(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
  try {
    await withLock('zipply-errlog', async () => {
      const list = (await local.get<ErrorEntry[]>(KEY)) ?? []
      list.push({ at: Date.now(), where, message })
      await local.set(KEY, list.slice(-MAX))
    })
  } catch {
    /* logging must never throw */
  }
}

export async function recentErrors(): Promise<ErrorEntry[]> {
  return (await local.get<ErrorEntry[]>(KEY)) ?? []
}

export async function clearErrors(): Promise<void> {
  await local.remove(KEY)
}

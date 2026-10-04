// Daily AI call counts per model, shared by the worker and the Profile page.
import { todayISO } from '@/shared/text'
import { db } from './db'
import { getSettings } from './repo'

export async function usageCount(model: string): Promise<number> {
  return (await db.usage.get(`${todayISO()}|${model}`))?.count ?? 0
}

export async function bumpUsage(model: string, to?: number): Promise<void> {
  const id = `${todayISO()}|${model}`
  const cur = await db.usage.get(id)
  await db.usage.put({ id, date: todayISO(), model, count: to ?? (cur?.count ?? 0) + 1 })
}

export async function usageToday(): Promise<{ model: string; count: number; limit: number | null }[]> {
  const s = await getSettings()
  const rows = await db.usage.where('date').equals(todayISO()).toArray()
  const get = (m: string) => rows.find((r) => r.model === m)?.count ?? 0
  return [
    { model: s.models.flash, count: get(s.models.flash), limit: s.dailyLimits.flash },
    { model: s.models.flashLite, count: get(s.models.flashLite), limit: s.dailyLimits.flashLite },
    { model: 'gemini-nano', count: get('gemini-nano'), limit: null },
  ]
}

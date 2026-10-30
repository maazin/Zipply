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

/** Gemini said a model's free daily quota is spent: skip it until tomorrow. */
export async function markSpent(model: string): Promise<void> {
  await db.usage.put({ id: `${todayISO()}|${model}|spent`, date: todayISO(), model: `${model}|spent`, count: 1 })
}

export async function isSpent(model: string): Promise<boolean> {
  return Boolean(await db.usage.get(`${todayISO()}|${model}|spent`))
}

/**
 * Earlier builds marked a model spent by setting its count to the daily limit,
 * also for a per-minute limit, which shut it off for the rest of the day. A
 * count exactly at the limit is one of those marks: clear it.
 */
export async function clearOldLimitMarks(limits: Record<string, number>): Promise<void> {
  const rows = await db.usage.where('date').equals(todayISO()).toArray()
  for (const r of rows) if (limits[r.model] != null && r.count === limits[r.model]) await db.usage.put({ ...r, count: 0 })
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

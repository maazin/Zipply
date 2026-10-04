// Failed sheet writes wait here and retry on browser start and every 15 minutes.
import type { JobRecord, QueueItem } from '@/shared/types'
import { db } from '@/lib/db'
import { appendRecord, writeStatus, type StatusUpdate } from './sheets'
import { NotConnectedError } from './google'

export async function enqueue(op: QueueItem['op'], payload: unknown, error: string): Promise<void> {
  await db.queue.add({ op, payload, attempts: 1, lastError: error, createdAt: Date.now() })
}

export async function queueSize(): Promise<number> {
  return db.queue.count()
}

let flushing = false

/** Retry every queued write in order. Stops early when offline or signed out. */
export async function flushQueue(): Promise<{ done: number; left: number }> {
  if (flushing) return { done: 0, left: await db.queue.count() }
  flushing = true
  let done = 0
  try {
    const items = await db.queue.orderBy('createdAt').toArray()
    for (const item of items) {
      try {
        if (item.op === 'append') {
          const rec = item.payload as JobRecord
          const row = await appendRecord(rec)
          const entry = await db.applied.where('appId').equals(rec.appId).first()
          if (entry && row) await db.applied.update(entry.key, { row })
        } else await writeStatus(item.payload as StatusUpdate)
        await db.queue.delete(item.id!)
        done++
      } catch (e) {
        await db.queue.update(item.id!, {
          attempts: item.attempts + 1,
          lastError: e instanceof Error ? e.message : String(e),
        })
        if (e instanceof NotConnectedError || !navigator.onLine) break
      }
    }
  } finally {
    flushing = false
  }
  return { done, left: await db.queue.count() }
}

// The answer bank was removed: upgrading must drop its table and every answer in it.
import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { ZipplyDB } from '@/lib/db'

describe('database upgrade', () => {
  it('drops the old answer bank and keeps everything else', async () => {
    const old = new Dexie('zipply')
    old.version(1).stores({
      vault: 'name',
      resumes: 'id, addedAt',
      answers: 'id, labelNorm, updatedAt',
      applied: 'key, appId, companyNorm, dateApplied',
      queue: '++id, createdAt',
      emails: 'id',
      usage: 'id, date',
      events: 'id, at, seen',
      unmatched: 'messageId, at',
    })
    old.version(2).stores({ unlogged: 'id, at' })
    await old.table('answers').bulkPut([
      { id: 'a', label: 'Why us?', labelNorm: 'why us', updatedAt: 1 },
      { id: 'b', label: 'Why us?', labelNorm: 'why us', updatedAt: 2 },
    ])
    await old.table('emails').put({ id: 'm1', at: 1 })
    old.close()

    const db = new ZipplyDB()
    await db.open()
    expect(db.tables.map((t) => t.name)).not.toContain('answers')
    expect(await db.emails.get('m1')).toEqual({ id: 'm1', at: 1 })
    db.close()
  })
})

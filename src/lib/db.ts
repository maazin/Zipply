import Dexie, { type EntityTable } from 'dexie'
import type { AppliedEntry, QueueItem, StatusEvent, UnmatchedEmail } from '@/shared/types'
import type { JobContext } from '@/shared/messages'
import type { Sealed } from './crypto'

export interface VaultRow extends Sealed {
  name: 'profile' | 'geminiKey' | 'check'
}

export interface ResumeRow extends Sealed {
  id: string
  name: string
  tag: string
  mime: string
  size: number
  addedAt: number
  isDefault: boolean
}

export interface UsageRow {
  id: string
  date: string
  model: string
  count: number
}

export interface EmailRow {
  id: string
  at: number
}

/** A form you filled but left without a confirmed submit. */
export interface UnloggedRow {
  id: string
  at: number
  job: JobContext
}

export class ZipplyDB extends Dexie {
  vault!: EntityTable<VaultRow, 'name'>
  resumes!: EntityTable<ResumeRow, 'id'>
  applied!: EntityTable<AppliedEntry, 'key'>
  queue!: EntityTable<QueueItem, 'id'>
  emails!: EntityTable<EmailRow, 'id'>
  usage!: EntityTable<UsageRow, 'id'>
  events!: EntityTable<StatusEvent, 'id'>
  unmatched!: EntityTable<UnmatchedEmail, 'messageId'>
  unlogged!: EntityTable<UnloggedRow, 'id'>

  constructor() {
    super('zipply')
    this.version(1).stores({
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
    this.version(2).stores({ unlogged: 'id, at' })
    // The answer bank is gone; this drops its table and everything in it.
    this.version(3).stores({ answers: null })
  }
}

export const db = new ZipplyDB()

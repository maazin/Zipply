import Dexie, { type EntityTable } from 'dexie'
import type { AppliedEntry, FieldKind, QueueItem, StatusEvent, UnmatchedEmail } from '@/shared/types'
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

export interface AnswerRow extends Sealed {
  id: string
  label: string
  labelNorm: string
  fieldKind: FieldKind
  host: string
  source: 'typed' | 'ai'
  updatedAt: number
  uses: number
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

export class ZipplyDB extends Dexie {
  vault!: EntityTable<VaultRow, 'name'>
  resumes!: EntityTable<ResumeRow, 'id'>
  answers!: EntityTable<AnswerRow, 'id'>
  applied!: EntityTable<AppliedEntry, 'key'>
  queue!: EntityTable<QueueItem, 'id'>
  emails!: EntityTable<EmailRow, 'id'>
  usage!: EntityTable<UsageRow, 'id'>
  events!: EntityTable<StatusEvent, 'id'>
  unmatched!: EntityTable<UnmatchedEmail, 'messageId'>

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
  }
}

export const db = new ZipplyDB()

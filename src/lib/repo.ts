// High-level storage API shared by the service worker and extension pages.
// Profile, resumes, the answer bank and the Gemini key are encrypted.
import type { AnswerBankEntry, Profile, ResumeContent, ResumeMeta, Settings, StoredResume } from '@/shared/types'
import { DEFAULT_SETTINGS, emptyProfile, uid } from '@/shared/defaults'
import { normalizeLabel } from '@/shared/text'
import { upsertAnswer } from '@/core/answerBank'
import { db } from './db'
import { getKey, resetKeys } from './keys'
import { open, seal } from './crypto'
import { local } from './store'

// ---------- Settings ----------

export async function getSettings(): Promise<Settings> {
  const s = await local.get<Partial<Settings>>('settings')
  return { ...DEFAULT_SETTINGS, ...s, models: { ...DEFAULT_SETTINGS.models, ...s?.models }, dailyLimits: { ...DEFAULT_SETTINGS.dailyLimits, ...s?.dailyLimits } }
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await local.set('settings', next)
  return next
}

// ---------- Profile ----------

/** Fill in fields added in later versions. */
function migrate(p: Partial<Profile>): Profile {
  const base = emptyProfile()
  return {
    ...base,
    ...p,
    basics: { ...base.basics, ...p.basics },
    links: { ...base.links, ...p.links },
    answers: { ...base.answers, ...p.answers },
    filters: { ...base.filters, ...p.filters },
    work: p.work ?? [],
    education: p.education ?? [],
    skills: p.skills ?? [],
    writingSamples: p.writingSamples ?? [],
  }
}

export async function getProfile(): Promise<Profile> {
  const row = await db.vault.get('profile')
  if (!row) return emptyProfile()
  return migrate(await open<Profile>(await getKey(), row))
}

export async function saveProfile(p: Profile): Promise<void> {
  const next = { ...p, updatedAt: Date.now() }
  await db.vault.put({ name: 'profile', ...(await seal(await getKey(), next)) })
}

// ---------- Gemini key ----------

export async function getGeminiKey(): Promise<string> {
  const row = await db.vault.get('geminiKey')
  return row ? open<string>(await getKey(), row) : ''
}

export async function setGeminiKey(apiKey: string): Promise<void> {
  if (!apiKey) {
    await db.vault.delete('geminiKey')
    return
  }
  await db.vault.put({ name: 'geminiKey', ...(await seal(await getKey(), apiKey.trim())) })
}

// ---------- Resumes ----------

export const MAX_RESUMES = 5

export async function listResumes(): Promise<ResumeMeta[]> {
  const rows = await db.resumes.orderBy('addedAt').toArray()
  return rows.map(({ id, name, tag, mime, size, addedAt, isDefault }) => ({ id, name, tag, mime, size, addedAt, isDefault }))
}

export async function getResume(id: string): Promise<StoredResume | null> {
  const row = await db.resumes.get(id)
  if (!row) return null
  const body = await open<{ content: ResumeContent; data: string }>(await getKey(), row)
  const { iv: _iv, ct: _ct, ...meta } = row
  return { ...meta, ...body }
}

export async function getResumeTexts(): Promise<{ id: string; tag: string; name: string; text: string; content: ResumeContent }[]> {
  const metas = await listResumes()
  const out = []
  for (const m of metas) {
    const r = await getResume(m.id)
    if (r) out.push({ id: r.id, tag: r.tag, name: r.name, text: r.content.text, content: r.content })
  }
  return out
}

export async function saveResume(r: Omit<StoredResume, 'id' | 'addedAt' | 'isDefault'> & Partial<Pick<StoredResume, 'id' | 'addedAt' | 'isDefault'>>): Promise<string> {
  const count = await db.resumes.count()
  const id = r.id ?? uid(8)
  const existing = r.id ? await db.resumes.get(r.id) : undefined
  if (!existing && count >= MAX_RESUMES) throw new Error(`You can keep up to ${MAX_RESUMES} resumes. Delete one first.`)
  const sealed = await seal(await getKey(), { content: r.content, data: r.data })
  await db.resumes.put({
    id,
    name: r.name,
    tag: r.tag,
    mime: r.mime,
    size: r.size,
    addedAt: r.addedAt ?? existing?.addedAt ?? Date.now(),
    isDefault: r.isDefault ?? existing?.isDefault ?? count === 0,
    ...sealed,
  })
  return id
}

export async function updateResumeMeta(id: string, patch: Partial<Pick<ResumeMeta, 'tag' | 'name' | 'isDefault'>>): Promise<void> {
  if (patch.isDefault) await db.resumes.toCollection().modify({ isDefault: false })
  await db.resumes.update(id, patch)
}

export async function deleteResume(id: string): Promise<void> {
  const wasDefault = (await db.resumes.get(id))?.isDefault
  await db.resumes.delete(id)
  if (wasDefault) {
    const first = await db.resumes.orderBy('addedAt').first()
    if (first) await db.resumes.update(first.id, { isDefault: true })
  }
}

// ---------- Answer bank ----------

export async function getAnswerBank(): Promise<AnswerBankEntry[]> {
  const key = await getKey()
  const rows = await db.answers.orderBy('updatedAt').reverse().toArray()
  return Promise.all(
    rows.map(async ({ iv, ct, ...rest }) => ({ ...rest, answer: await open<string>(key, { iv, ct }) })),
  )
}

async function putAnswer(e: AnswerBankEntry) {
  const { answer, ...rest } = e
  await db.answers.put({ ...rest, ...(await seal(await getKey(), answer)) })
}

export async function saveAnswer(entry: Omit<AnswerBankEntry, 'id' | 'labelNorm' | 'uses' | 'updatedAt'> & { id?: string }): Promise<void> {
  const bank = await getAnswerBank()
  const next = upsertAnswer(bank, { ...entry, id: entry.id ?? uid(8) })
  const labelNorm = normalizeLabel(entry.label)
  const changed = next.find((e) => e.labelNorm === labelNorm)
  if (changed) await putAnswer(changed)
}

export async function updateAnswer(e: AnswerBankEntry): Promise<void> {
  await putAnswer({ ...e, labelNorm: normalizeLabel(e.label), updatedAt: Date.now() })
}

export async function markAnswerUsed(id: string): Promise<void> {
  const row = await db.answers.get(id)
  if (row) await db.answers.update(id, { uses: row.uses + 1 })
}

export async function deleteAnswer(id: string): Promise<void> {
  await db.answers.delete(id)
}

// ---------- Export / import / delete ----------

export interface ExportFile {
  format: 'zipply-profile'
  version: 1
  exportedAt: string
  profile: Profile
  answerBank: AnswerBankEntry[]
  resumes: StoredResume[]
}

export async function exportAll(): Promise<ExportFile> {
  const metas = await listResumes()
  const resumes: StoredResume[] = []
  for (const m of metas) {
    const r = await getResume(m.id)
    if (r) resumes.push(r)
  }
  return {
    format: 'zipply-profile',
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: await getProfile(),
    answerBank: await getAnswerBank(),
    resumes,
  }
}

export async function importAll(file: ExportFile): Promise<void> {
  if (file?.format !== 'zipply-profile') throw new Error('This is not a Zipply profile file.')
  await saveProfile(migrate(file.profile))
  for (const e of file.answerBank ?? []) await putAnswer({ ...e, labelNorm: normalizeLabel(e.label) })
  for (const r of (file.resumes ?? []).slice(0, MAX_RESUMES)) {
    await db.resumes.delete(r.id)
    await saveResume(r)
  }
}

export async function deleteAll(): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()))
  await chrome.storage.local.clear()
  await chrome.storage.session.clear()
  await resetKeys()
}

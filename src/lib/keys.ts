import { db } from './db'
import { deriveKey, exportKey, fromB64, importKey, newSalt, open, randomKey, seal, toB64, type Sealed } from './crypto'
import { local, session } from './store'

interface CryptoMeta {
  mode: 'device' | 'passphrase'
  salt?: string
  deviceKey?: string
}

export class LockedError extends Error {
  constructor() {
    super('Zipply is locked. Enter your passphrase to unlock.')
    this.name = 'LockedError'
  }
}

const META = 'cryptoMeta'
const SESSION_KEY = 'zk'
const CHECK = 'zipply-ok'

let cached: CryptoKey | null = null

// Another extension page may change the key (passphrase set, lock, delete all).
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'session' && SESSION_KEY in changes) || (area === 'local' && META in changes)) cached = null
  })
}

async function cache(key: CryptoKey) {
  cached = key
  await session.set(SESSION_KEY, await exportKey(key))
}

export async function isLocked(): Promise<boolean> {
  try {
    await getKey()
    return false
  } catch (e) {
    if (e instanceof LockedError) return true
    throw e
  }
}

export async function usesPassphrase(): Promise<boolean> {
  return (await local.get<CryptoMeta>(META))?.mode === 'passphrase'
}

/** The data key, creating a device key on first run. Throws LockedError when a passphrase is needed. */
export async function getKey(): Promise<CryptoKey> {
  if (cached) return cached
  const fromSession = await session.get<string>(SESSION_KEY)
  if (fromSession) {
    cached = await importKey(fromSession)
    return cached
  }
  const meta = await local.get<CryptoMeta>(META)
  if (!meta) {
    const key = await randomKey()
    await local.set(META, { mode: 'device', deviceKey: await exportKey(key) } satisfies CryptoMeta)
    await db.vault.put({ name: 'check', ...(await seal(key, CHECK)) })
    await cache(key)
    return key
  }
  if (meta.mode === 'device' && meta.deviceKey) {
    const key = await importKey(meta.deviceKey)
    await cache(key)
    return key
  }
  throw new LockedError()
}

export async function unlock(passphrase: string): Promise<boolean> {
  const meta = await local.get<CryptoMeta>(META)
  if (!meta?.salt) return false
  const key = await deriveKey(passphrase, fromB64(meta.salt))
  const check = await db.vault.get('check')
  try {
    if (!check || (await open<string>(key, check)) !== CHECK) return false
  } catch {
    return false
  }
  await cache(key)
  return true
}

export async function lock(): Promise<void> {
  cached = null
  await session.remove(SESSION_KEY)
}

/** Re-encrypt everything under a new key. */
async function rekey(oldKey: CryptoKey, newKey: CryptoKey) {
  const re = async <T extends Sealed>(row: T): Promise<T> => ({ ...row, ...(await seal(newKey, await open(oldKey, row))) })
  const [vault, resumes, answers] = await Promise.all([db.vault.toArray(), db.resumes.toArray(), db.answers.toArray()])
  const v2 = await Promise.all(vault.map(re))
  const r2 = await Promise.all(resumes.map(re))
  const a2 = await Promise.all(answers.map(re))
  await db.transaction('rw', db.vault, db.resumes, db.answers, async () => {
    await db.vault.bulkPut(v2)
    await db.resumes.bulkPut(r2)
    await db.answers.bulkPut(a2)
  })
}

export async function setPassphrase(passphrase: string): Promise<void> {
  if (passphrase.length < 8) throw new Error('Use at least 8 characters.')
  const oldKey = await getKey()
  const salt = newSalt()
  const newKey = await deriveKey(passphrase, salt)
  await rekey(oldKey, newKey)
  await local.set(META, { mode: 'passphrase', salt: toB64(salt) } satisfies CryptoMeta)
  await cache(newKey)
}

export async function removePassphrase(): Promise<void> {
  const oldKey = await getKey()
  const newKey = await randomKey()
  await rekey(oldKey, newKey)
  await local.set(META, { mode: 'device', deviceKey: await exportKey(newKey) } satisfies CryptoMeta)
  await cache(newKey)
}

/** Forget every key (used by Delete all). */
export async function resetKeys(): Promise<void> {
  cached = null
  await session.remove(SESSION_KEY)
  await local.remove(META)
}

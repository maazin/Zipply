// Typed wrappers around chrome.storage.

export const local = {
  async get<T>(key: string): Promise<T | undefined> {
    return (await chrome.storage.local.get(key))[key] as T | undefined
  },
  set(key: string, value: unknown): Promise<void> {
    return chrome.storage.local.set({ [key]: value })
  },
  remove(key: string): Promise<void> {
    return chrome.storage.local.remove(key)
  },
}

/** In-memory storage that's cleared when the browser closes. Not visible to content scripts. */
export const session = {
  async get<T>(key: string): Promise<T | undefined> {
    return (await chrome.storage.session.get(key))[key] as T | undefined
  },
  set(key: string, value: unknown): Promise<void> {
    return chrome.storage.session.set({ [key]: value })
  },
  remove(key: string): Promise<void> {
    return chrome.storage.session.remove(key)
  },
}

/**
 * Chrome sync storage: follows you to a reinstall when Chrome sync is on.
 * Best effort; it can be off or over quota, so failures are ignored.
 */
export const synced = {
  async get<T>(key: string): Promise<T | undefined> {
    try {
      return (await chrome.storage.sync.get(key))[key] as T | undefined
    } catch {
      return undefined
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    try {
      await chrome.storage.sync.set({ [key]: value })
    } catch {
      /* sync off or over quota */
    }
  },
}

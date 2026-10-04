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

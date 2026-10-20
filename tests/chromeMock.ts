// Minimal chrome.* for tests that touch storage.
export const stores: Record<'local' | 'session', Record<string, unknown>> = { local: {}, session: {} }

function area(name: 'local' | 'session') {
  return {
    get: async (k?: string | null) => (k == null ? { ...stores[name] } : k in stores[name] ? { [k]: structuredClone(stores[name][k]) } : {}),
    set: async (o: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, 1))
      Object.assign(stores[name], structuredClone(o))
    },
    remove: async (k: string) => void delete stores[name][k],
    clear: async () => void (stores[name] = {}),
  }
}

export function installChrome(extra: Record<string, unknown> = {}) {
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area('local'), session: area('session'), onChanged: { addListener() {} } },
    runtime: { sendMessage: async () => ({}) },
    identity: { getAuthToken: async () => ({ token: 't' }), removeCachedAuthToken: async () => {} },
    ...extra,
  }
}

export function resetStores() {
  stores.local = {}
  stores.session = {}
}

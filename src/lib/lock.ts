// Run read-modify-write steps one at a time, across the service worker and
// every extension page (Web Locks share the extension's origin). Calls in the
// same context are also queued, so it works where Web Locks are missing.
const chains = new Map<string, Promise<unknown>>()

export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks
  const prev = chains.get(name) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(() => (locks ? (locks.request(name, fn) as Promise<T>) : fn()))
  chains.set(name, run.catch(() => undefined))
  return run
}

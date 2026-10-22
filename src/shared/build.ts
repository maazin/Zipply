// Which build of Zipply this code is. Each `npm run build` gets a new one, and
// dist/build.json holds the one on disk, so a running copy can tell it's stale.
export const BUILD: string = typeof __BUILD__ === 'string' ? __BUILD__ : 'test'

/** "Oct 22, 4:41 AM" */
export function buildLabel(build = BUILD): string {
  const d = new Date(build)
  return Number.isNaN(d.getTime()) ? build : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

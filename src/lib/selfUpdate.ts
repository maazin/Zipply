// Unpacked installs read pages from disk but keep the background running from
// whenever the extension was last loaded. After a rebuild the two disagree and
// the old background breaks. These checks reload the extension when that
// happens, so a new build takes effect without visiting chrome://extensions.
import { BUILD } from '@/shared/build'
import { local } from './store'

const GUARD = 'reloadedFor'

/** The build on disk (dist/build.json), or null if it can't be read. */
export async function diskBuild(): Promise<string | null> {
  try {
    const r = await fetch(chrome.runtime.getURL('build.json'), { cache: 'no-store' })
    return ((await r.json()) as { build?: string }).build ?? null
  } catch {
    return null
  }
}

/** Reload once per build, so a failure can never become a reload loop. */
async function reloadOnce(target: string): Promise<boolean> {
  const last = await local.get<{ build: string; at: number }>(GUARD)
  if (last?.build === target && Date.now() - last.at < 10 * 60_000) return false
  await local.set(GUARD, { build: target, at: Date.now() })
  chrome.runtime.reload()
  return true
}

/** In the background: reload if a newer build is on disk. */
export async function reloadIfNewBuildOnDisk(): Promise<boolean> {
  const disk = await diskBuild()
  return disk != null && disk !== BUILD ? reloadOnce(disk) : false
}

/** In a page (always the build on disk): reload if the background is older. */
export async function reloadIfBackgroundStale(): Promise<boolean> {
  let theirs: string | undefined
  try {
    theirs = ((await chrome.runtime.sendMessage({ type: 'build' })) as { build?: string } | undefined)?.build
  } catch {
    theirs = undefined
  }
  return theirs === BUILD ? false : reloadOnce(BUILD)
}

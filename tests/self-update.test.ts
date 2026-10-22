// A rebuilt unpacked Zipply reloads itself once, and never loops.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installChrome, resetStores } from './chromeMock'

const reload = vi.fn()
let backgroundBuild: string | null | undefined
let unreachable = false
let diskBuild = 'test'
installChrome({
  runtime: {
    reload,
    getURL: (p: string) => `chrome-extension://x/${p}`,
    sendMessage: async (m: { type: string }) => {
      if (unreachable) throw new Error('Could not establish connection. Receiving end does not exist.')
      // An old background answers null to a message it doesn't know.
      return m.type === 'build' ? (backgroundBuild == null ? backgroundBuild : { build: backgroundBuild }) : {}
    },
  },
})
globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ build: diskBuild }))) as typeof fetch

const { reloadIfBackgroundStale, reloadIfNewBuildOnDisk } = await import('@/lib/selfUpdate')
const { BUILD } = await import('@/shared/build')

beforeEach(() => {
  resetStores()
  reload.mockClear()
  backgroundBuild = BUILD
  unreachable = false
  diskBuild = BUILD
})

describe('self-update', () => {
  it('does nothing when the page and background are the same build', async () => {
    expect(await reloadIfBackgroundStale()).toBe(false)
    expect(await reloadIfNewBuildOnDisk()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads when the background is an older build', async () => {
    backgroundBuild = '2026-10-21T20:54:00.000Z'
    expect(await reloadIfBackgroundStale()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads when the background is so old it does not know the question', async () => {
    backgroundBuild = null
    expect(await reloadIfBackgroundStale()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload when the background is restarting and cannot be reached', async () => {
    unreachable = true
    expect(await reloadIfBackgroundStale()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads only once per build, so it can never loop', async () => {
    backgroundBuild = 'old'
    await reloadIfBackgroundStale()
    await reloadIfBackgroundStale()
    await reloadIfBackgroundStale()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('in the background, reloads when a newer build is on disk', async () => {
    diskBuild = '2099-01-01T00:00:00.000Z'
    expect(await reloadIfNewBuildOnDisk()).toBe(true)
    expect(await reloadIfNewBuildOnDisk()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload when build.json cannot be read', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    expect(await reloadIfNewBuildOnDisk()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})

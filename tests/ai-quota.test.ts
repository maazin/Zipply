// Gemini's free tier has a per-minute limit as well as a daily one. Only the
// daily one may shut a model off until tomorrow.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installChrome, resetStores } from './chromeMock'

installChrome()

vi.mock('@/background/ai/gemini', async (orig) => {
  const real = await orig<typeof import('@/background/ai/gemini')>()
  return { ...real, geminiGenerate: vi.fn() }
})

const { quotaFrom } = await import('@/background/ai/gemini')
const { geminiGenerate } = await import('@/background/ai/gemini')
const { runAi } = await import('@/background/ai/router')
const { setGeminiKey, getSettings } = await import('@/lib/repo')
const { isSpent, usageCount, bumpUsage, clearOldLimitMarks } = await import('@/lib/usage')
const { db } = await import('@/lib/db')

const perMinute = (secs: number) =>
  `{"error":{"code":429,"message":"You exceeded your current quota. Please retry in ${secs}.53s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier","quotaValue":"10"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"${secs}s"}]}}`
const perDay =
  '{"error":{"code":429,"message":"You exceeded your current quota.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"250"}]}]}}'

beforeEach(async () => {
  resetStores()
  await Promise.all(db.tables.map((t) => t.clear()))
  await setGeminiKey('k')
  vi.mocked(geminiGenerate).mockReset()
  ;(globalThis as { LanguageModel?: unknown }).LanguageModel = undefined
})

describe('Gemini quota errors', () => {
  it('tell the per-minute limit from the daily one', () => {
    expect(quotaFrom('m', perMinute(37))).toMatchObject({ daily: false, retryMs: 37_000 })
    expect(quotaFrom('m', perDay)).toMatchObject({ daily: true })
  })

  it("a per-minute limit doesn't shut the model off for the day", async () => {
    const { models } = await getSettings()
    vi.mocked(geminiGenerate).mockRejectedValueOnce(quotaFrom(models.flash, perMinute(1))).mockResolvedValueOnce('from lite')
    expect(await runAi('write', 's', 'p')).toEqual({ text: 'from lite', model: models.flashLite })
    expect(await isSpent(models.flash)).toBe(false)
    // After its rest, Flash is used again.
    await new Promise((r) => setTimeout(r, 1100))
    vi.mocked(geminiGenerate).mockResolvedValueOnce('from flash')
    expect(await runAi('write', 's', 'p')).toEqual({ text: 'from flash', model: models.flash })
  })

  it('waits out a short limit when every model is resting, instead of failing', async () => {
    const { models } = await getSettings()
    vi.mocked(geminiGenerate)
      .mockRejectedValueOnce(quotaFrom(models.flash, perMinute(1)))
      .mockRejectedValueOnce(quotaFrom(models.flashLite, perMinute(1)))
      .mockResolvedValueOnce('after the wait')
    expect((await runAi('write', 's', 'p'))?.text).toBe('after the wait')
  })

  it('a spent daily quota skips the model until tomorrow', async () => {
    const { models } = await getSettings()
    vi.mocked(geminiGenerate).mockRejectedValueOnce(quotaFrom(models.flash, perDay)).mockResolvedValue('from lite')
    await runAi('write', 's', 'p')
    expect(await isSpent(models.flash)).toBe(true)
    await runAi('write', 's', 'p')
    expect(vi.mocked(geminiGenerate).mock.calls.map((c) => c[0].model)).toEqual([models.flash, models.flashLite, models.flashLite])
  })

  it('clears the "spent" marks earlier builds left after a per-minute limit', async () => {
    const { models, dailyLimits } = await getSettings()
    await bumpUsage(models.flash, dailyLimits.flash)
    await bumpUsage(models.flashLite, 12)
    await clearOldLimitMarks({ [models.flash]: dailyLimits.flash, [models.flashLite]: dailyLimits.flashLite })
    expect(await usageCount(models.flash)).toBe(0)
    expect(await usageCount(models.flashLite)).toBe(12)
  })
})

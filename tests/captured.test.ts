// Every saved real form in tests/fixtures/captured runs through detection and a fill.
import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FillContext } from '@/shared/messages'
import { fillPage } from '@/content/fill'
import { pickAdapter } from '@/content/adapters'
import { detectApplication } from '@/content/detect'
import { sanitizeForm, scrubPersonal } from '@/content/capture'
import { profile } from './helpers'

;(globalThis as unknown as { chrome: unknown }).chrome = { runtime: { sendMessage: vi.fn(async () => ({})) } }

const DIR = join(import.meta.dirname, 'fixtures', 'captured')
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.html')) : []

function load(html: string): URL {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  document.head.innerHTML = doc.head.innerHTML
  document.body.innerHTML = doc.body.innerHTML
  const meta = doc.querySelector('meta[name="zipply-url"]')?.getAttribute('content') || 'https://captured.example/'
  return new URL(meta.startsWith('http') ? meta : `https://captured.example${meta}`)
}

const ctx = (): FillContext => ({ profile: profile(), bank: [], resume: null, threshold: 0.75, autoDraft: false, aiReady: false, posting: null })

async function check(html: string) {
  const url = load(html)
  expect(detectApplication(document, url).isApplication).toBe(true)
  const reports = await fillPage(pickAdapter(url, document), ctx(), document)
  return reports.filter((r) => r.status === 'filled' || r.status === 'low').length
}

describe('capture', () => {
  it('removes what you typed, tokens and scripts, and keeps the form', async () => {
    load(readFileSync(join(import.meta.dirname, 'fixtures', 'greenhouse.html'), 'utf8'))
    ;(document.querySelector('#first_name') as HTMLInputElement).setAttribute('value', 'Ada')
    ;(document.querySelector('#q5') as HTMLTextAreaElement).textContent = 'Because I love it'
    ;(document.querySelector('#q6') as HTMLInputElement).setAttribute('checked', '')
    document.body.insertAdjacentHTML('beforeend', '<input type="hidden" name="authenticity_token" value="SECRET123"><script>track()</script><a href="/x?session=abc">x</a><p>Hi Ada Lovelace</p>')
    const raw = sanitizeForm(document, 'https://boards.greenhouse.io/globex/jobs/4012345?gh_src=xyz&t=SECRET')
    const html = scrubPersonal(raw, ['Ada Lovelace', 'ada@example.com'])
    expect(html).not.toMatch(/SECRET|Because I love it|track\(\)|session=abc|Ada Lovelace|value="Ada"/)
    expect(html).not.toMatch(/checked/)
    expect(html).toContain('application/ld+json')
    expect(html).toContain('content="https://boards.greenhouse.io/globex/jobs/4012345"')
    // The captured copy still works as a test.
    expect(await check(html)).toBeGreaterThanOrEqual(6)
  }, 20000)
})

describe.skipIf(!files.length)('captured real forms', () => {
  for (const f of files) {
    it(`${f} is detected and fills`, async () => {
      expect(await check(readFileSync(join(DIR, f), 'utf8'))).toBeGreaterThanOrEqual(3)
    }, 30000)
  }
})

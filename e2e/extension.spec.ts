// Loads the built extension (npm run build first) in Chromium and runs it
// against saved copies of ATS forms served at their real hostnames.
import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const FIX = join(ROOT, 'tests', 'fixtures')

let context: BrowserContext
let worker: Worker
let extId: string
const errors: string[] = []

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'zipply-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  })
  await context.route('https://boards.greenhouse.io/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, 'greenhouse.html'), 'utf8') }),
  )
  await context.route('https://jobs.lever.co/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, 'lever.html'), 'utf8') }),
  )
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  extId = new URL(worker.url()).host
  context.on('page', (p) => p.on('console', (m) => m.type() === 'error' && errors.push(`${p.url()}: ${m.text()}`)))
})

test.afterAll(async () => {
  await context?.close()
})

test('Profile page renders and imports a profile', async () => {
  const page = await context.newPage()
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(`chrome-extension://${extId}/src/options/index.html`)
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()
  await expect(page.getByText('Drop your resume here')).toBeVisible()

  const file = join(mkdtempSync(join(tmpdir(), 'zp-')), 'profile.json')
  writeFileSync(
    file,
    JSON.stringify({
      format: 'zipply-profile',
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: {
        basics: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '(813) 555-0100', city: 'Tampa', state: 'FL', country: 'United States' },
        links: { linkedin: 'https://linkedin.com/in/ada', github: 'https://github.com/ada', portfolio: '', other: '' },
        work: [{ id: 'w1', title: 'Data Analyst Intern', company: 'Acme Corp', location: 'Tampa, FL', start: '2025-05', end: '2025-08', current: false, description: 'SQL, Tableau' }],
        education: [],
        skills: ['Python', 'SQL'],
        answers: { workAuthorized: 'Yes', needsSponsorship: 'No' },
      },
      answerBank: [],
      resumes: [],
    }),
  )
  await page.locator('#privacy input[type=file]').setInputFiles(file)
  await expect(page.getByText('Imported.')).toBeVisible()
  await page.reload()
  await expect(page.locator('#basics input').first()).toHaveValue('Ada')
  await page.close()
})

test('Fills a Greenhouse form on its real hostname', async () => {
  const page = await context.newPage()
  await page.goto('https://boards.greenhouse.io/globex/jobs/4012345')
  // Content script registers the frame with the worker.
  await expect
    .poll(async () => worker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('frames:')).length), { timeout: 10_000 })
    .toBeGreaterThan(0)

  const reports = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://boards.greenhouse.io/*' })
    return (await chrome.tabs.sendMessage(tab.id!, { type: 'fill', resumeId: null }, { frameId: 0 })) as { reports: { status: string }[] }
  })
  expect(reports.reports.length).toBeGreaterThan(8)
  await expect(page.locator('#first_name')).toHaveValue('Ada')
  await expect(page.locator('#last_name')).toHaveValue('Lovelace')
  await expect(page.locator('#email')).toHaveValue('ada@example.com')
  await expect(page.locator('#q4')).toHaveValue('0') // sponsorship: No
  await expect(page.locator('#gender option:checked')).toHaveText('Decline To Self Identify')
  await expect(page.locator('#q6')).not.toBeChecked()

  // The toolbar dot is on for this tab.
  const badge = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://boards.greenhouse.io/*' })
    return chrome.action.getBadgeText({ tabId: tab.id })
  })
  expect(badge).toBe(' ')
  await page.close()
})

test('Scans a Lever posting and the side panel renders', async () => {
  const page = await context.newPage()
  await page.goto('https://jobs.lever.co/globex/1b2c3d4e/apply')
  await page.waitForTimeout(1500)
  const scan = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://jobs.lever.co/*' })
    return chrome.tabs.sendMessage(tab.id!, { type: 'scan' }, { frameId: 0 })
  })
  expect(scan).toMatchObject({ ats: 'Lever', posting: { title: 'Data Analyst', company: 'Globex', jobId: '1b2c3d4e' } })

  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`)
  await expect(panel.getByText('Zipply', { exact: true })).toBeVisible()
  await panel.close()
  await page.close()
})

test('No console errors on extension pages', () => {
  expect(errors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND/.test(e))).toEqual([])
})

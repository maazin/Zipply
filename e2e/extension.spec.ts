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
  // Registered after the general Greenhouse route, so it wins for this path.
  await context.route('https://boards.greenhouse.io/globex/jobs/4012345/confirmation', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="application_confirmation"><h1>Thank you for applying to Globex!</h1></div>' }),
  )
  await context.route('https://careers.initech.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, 'custom.html'), 'utf8') }),
  )
  await context.route('https://shop.example.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1>Checkout</h1><form><label>Full name <input name=name></label><label>Email <input type=email></label><label>Address <input name=address></label><button>Pay now</button></form>',
    }),
  )
  await context.route('https://www.umbrella.org/**', (route) => {
    const form = readFileSync(join(FIX, 'custom.html'), 'utf8').match(/<form>[\s\S]*<\/form>/)![0]
    route.fulfill({
      contentType: 'text/html',
      body: `<h1>Open roles</h1><button id="apply">Apply now</button><div id="slot"></div>
        <script>document.getElementById('apply').onclick = () => { document.getElementById('slot').innerHTML = ${JSON.stringify(form)} }</script>`,
    })
  })
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

test('Adds a PDF resume and grades it', async () => {
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`chrome-extension://${extId}/src/options/index.html`)
  await page.locator('#resumes input[type=file]').setInputFiles(join(FIX, 'resume.pdf'))
  await expect(page.locator('#resumes').getByText('resume.pdf')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('#resumes').getByText(/ATS read: (Good|Fix)/)).toBeVisible()
  await expect(page.locator('#resumes').getByText(/detached/i)).toHaveCount(0)
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

  // Leave the filled form without submitting: the panel lists it to log or dismiss.
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://boards.greenhouse.io/*' }))[0].id)
  await page.goto('https://jobs.lever.co/globex/1b2c3d4e/apply')
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html?tabId=${tabId}`)
  await expect(panel.getByText('Filled but not logged')).toBeVisible({ timeout: 10_000 })
  await expect(panel.getByText('Data Analyst I')).toBeVisible()
  await panel.close()
  await page.close()
})

test('Logs a submitted application and shows it waiting for the sheet', async () => {
  const page = await context.newPage()
  await page.goto('https://boards.greenhouse.io/globex/jobs/4012345')
  await expect
    .poll(async () => worker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).some((k) => k.startsWith('job:'))), { timeout: 10_000 })
    .toBe(true)
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://boards.greenhouse.io/*' })
    await chrome.tabs.sendMessage(tab.id!, { type: 'fill', resumeId: null }, { frameId: 0 })
  })
  await expect(page.locator('#first_name')).toHaveValue('Ada')

  // Submitting reaches the confirmation page: the job is logged. Google isn't
  // connected here, so it waits in the queue, and the Profile page says so.
  await page.goto('https://boards.greenhouse.io/globex/jobs/4012345/confirmation')
  const opts = await context.newPage()
  await expect
    .poll(async () => {
      await opts.goto(`chrome-extension://${extId}/src/options/index.html#connections`)
      return opts.getByText('1 application is waiting to reach your sheet').count()
    }, { timeout: 15_000 })
    .toBe(1)
  await expect(opts.locator('#connections')).toContainText('Globex: Data Analyst I')
  await opts.close()
  await page.close()
})

test('Detects and fills an application on a site with no adapter', async () => {
  const badgeFor = (pattern: string) =>
    worker.evaluate(async (p) => {
      const [tab] = await chrome.tabs.query({ url: p })
      return chrome.action.getBadgeText({ tabId: tab.id })
    }, pattern)

  const shop = await context.newPage()
  await shop.goto('https://shop.example.com/checkout')
  const job = await context.newPage()
  await job.goto('https://careers.initech.com/jobs/42')
  await expect.poll(() => badgeFor('https://careers.initech.com/*'), { timeout: 10_000 }).toBe(' ')
  expect(await badgeFor('https://shop.example.com/*')).toBe('')

  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://careers.initech.com/*' })
    await chrome.tabs.sendMessage(tab.id!, { type: 'fill', resumeId: null }, { frameId: 0 })
  })
  await expect(job.locator('input[name="applicant_given"]')).toHaveValue('Ada')
  await expect(job.locator('input[name="contact"]')).toHaveValue('ada@example.com')
  await shop.close()
  await job.close()

  // A form that only appears after clicking "Apply" is picked up too.
  const late = await context.newPage()
  await late.goto('https://www.umbrella.org/careers')
  await late.waitForTimeout(1500)
  expect(await badgeFor('https://www.umbrella.org/*')).toBe('')
  await late.click('#apply')
  await expect.poll(() => badgeFor('https://www.umbrella.org/*'), { timeout: 10_000 }).toBe(' ')
  await late.close()
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

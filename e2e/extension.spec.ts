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
  await context.route('https://www.hooli.com/careers/apply', (route) =>
    route.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, 'custom.html'), 'utf8') }),
  )
  await context.route('https://www.hooli.com/thank-you', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Thank you for applying!</h1><p>We will be in touch.</p>' }),
  )
  await context.route('https://www.linkedin.com/jobs/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, 'linkedin.html'), 'utf8') }),
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
  // One summary line; open it to see the job.
  await expect(panel.getByTestId('since-last-time')).toContainText('1 to log', { timeout: 10_000 })
  await panel.getByRole('button', { name: /Since last time/ }).click()
  await expect(panel.getByText('Filled but not logged')).toBeVisible()
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

test('The Zipply tab sits on job pages, opens the panel, and hides per site', async () => {
  const shop = await context.newPage()
  await shop.goto('https://shop.example.com/checkout')
  const job = await context.newPage()
  await job.goto('https://careers.initech.com/jobs/42')
  const tab = job.locator('zipply-tab .tab')
  await expect(tab).toBeVisible({ timeout: 10_000 })
  // The green dot: there's a form to fill.
  await expect(tab).toHaveClass(/form/)
  await shop.waitForTimeout(1500)
  await expect(shop.locator('zipply-tab')).toHaveCount(0)
  await shop.close()

  // A click opens the side panel for this tab (Chrome accepts it: the click counts as your action).
  await worker.evaluate(() => {
    const g = globalThis as { panelOpens?: string[] }
    g.panelOpens = []
    const open = chrome.sidePanel.open.bind(chrome.sidePanel)
    chrome.sidePanel.open = (o) =>
      open(o).then(
        () => void g.panelOpens!.push('opened'),
        (e: Error) => void g.panelOpens!.push(e.message),
      )
  })
  await tab.click()
  await expect.poll(() => worker.evaluate(() => (globalThis as { panelOpens?: string[] }).panelOpens)).toEqual(['opened'])
  await expect(job.locator('zipply-tab .note')).toHaveCount(0)
  // Close it again: an open panel follows every tab and would change what later tests see.
  await worker.evaluate(async () => {
    await chrome.sidePanel.setOptions({ enabled: false })
    await chrome.sidePanel.setOptions({ enabled: true })
  })

  // Dragged, it moves and stays where you left it.
  const box = (await tab.boundingBox())!
  await job.mouse.move(box.x + 20, box.y + 20)
  await job.mouse.down()
  await job.mouse.move(box.x + 20, box.y + 140, { steps: 6 })
  await job.mouse.up()
  expect((await tab.boundingBox())!.y).toBeGreaterThan(box.y + 100)
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('sideTabTop')).sideTabTop)).toBeGreaterThan(0)

  await job.locator('zipply-tab').hover()
  await job.locator('zipply-tab .close').click()
  await expect(job.locator('zipply-tab .tab')).toHaveCount(0)
  await job.reload()
  await job.waitForTimeout(2500)
  await expect(job.locator('zipply-tab')).toHaveCount(0)
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('sideTabHidden')).sideTabHidden)).toEqual(['careers.initech.com'])
  await worker.evaluate(() => chrome.storage.local.remove(['sideTabHidden', 'sideTabTop']))
  await job.close()
})

test('Logs a submit that redirects to a different thank-you address', async () => {
  const unlogged = () =>
    worker.evaluate(
      () =>
        new Promise<number>((res) => {
          const r = indexedDB.open('zipply')
          r.onsuccess = () => {
            const q = r.result.transaction('unlogged').objectStore('unlogged').count()
            q.onsuccess = () => res(q.result)
          }
        }),
    )
  const page = await context.newPage()

  // Typing in a field yourself is not a Zipply fill: leaving doesn't flag it.
  await page.goto('https://www.hooli.com/careers/apply')
  await page.waitForTimeout(1500)
  const before = await unlogged()
  await page.fill('input[name="pc"]', '10001')
  await page.locator('input[name="pc"]').blur()
  await page.waitForTimeout(800)
  await page.goto('https://shop.example.com/checkout')
  await page.waitForTimeout(800)
  expect(await unlogged()).toBe(before)

  // Fill, submit, land on /thank-you: the job is logged (queued, Google isn't connected here).
  await page.goto('https://www.hooli.com/careers/apply')
  await expect
    .poll(
      async () =>
        worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: 'https://www.hooli.com/*' })
          return Boolean(tab && (await chrome.storage.session.get(`frames:${tab.id}`))[`frames:${tab.id}`])
        }),
      { timeout: 10_000 },
    )
    .toBe(true)
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.hooli.com/*' })
    await chrome.tabs.sendMessage(tab.id!, { type: 'fill', resumeId: null }, { frameId: 0 })
  })
  await expect(page.locator('input[name="applicant_given"]')).toHaveValue('Ada')
  await page.goto('https://www.hooli.com/thank-you')
  const opts = await context.newPage()
  await expect
    .poll(async () => {
      await opts.goto(`chrome-extension://${extId}/src/options/index.html#connections`)
      return (await opts.locator('#connections').innerText()).includes('Initech: Junior Data Engineer')
    }, { timeout: 15_000 })
    .toBe(true)
  await opts.close()
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

test('The panel shows the keywords you match, and Pause stops filling the next steps', async () => {
  const page = await context.newPage()
  const panel = await context.newPage()
  try {
    await page.goto('https://www.linkedin.com/jobs/search/?currentJobId=111')
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.linkedin.com/*' }))[0].id!)
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html?tabId=${tabId}`)
    await expect(panel.getByTestId('matched-keywords')).toContainText('Top matches', { timeout: 15_000 })
    await expect(panel.getByTestId('matched-keywords')).toContainText('SQL')

    // No form here yet: Zipply waits to fill the application when Apply opens it. Pause cancels that.
    await panel.getByRole('button', { name: 'Fill the application when it opens' }).click()
    await expect(panel.getByRole('button', { name: 'Pause' })).toBeVisible()
    expect(await worker.evaluate((id) => chrome.storage.session.get(`auto:${id}`), tabId)).not.toEqual({})
    await panel.getByRole('button', { name: 'Pause' }).click()
    await expect(panel.getByTestId('paused')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Pause' })).toHaveCount(0)
    expect(await worker.evaluate((id) => chrome.storage.session.get(`auto:${id}`), tabId)).toEqual({})
  } finally {
    await panel.close()
    await page.close()
  }
})

test('Shows a match score on a LinkedIn job and its card', async () => {
  const page = await context.newPage()
  await page.goto('https://www.linkedin.com/jobs/search/?currentJobId=111')
  const detail = page.locator('.jobs-search__job-details--container [data-zipply-pill="111"]')
  await expect(detail).toHaveText(/^\d+ · (Apply|Maybe|Skip)( · ✓ [^·]+)?$/, { timeout: 10_000 })
  await expect(page.locator('li[data-occludable-job-id="111"] [data-zipply-pill="111"]')).toHaveText(/^\d+ · /)
  await expect(page.locator('[data-zipply-pill="222"]')).toHaveCount(0)
  // Inside the h1, on the title's line.
  await expect(page.locator('.job-details-jobs-unified-top-card__job-title h1 > [data-zipply-pill="111"]')).toHaveCount(1)
  // Open job 222 the way LinkedIn does: same page, same title element, new text.
  await page.evaluate(() => {
    history.pushState(null, '', '/jobs/search/?currentJobId=222')
    document.querySelector('.job-details-jobs-unified-top-card__job-title h1 a')!.textContent = 'Senior Staff Engineer'
    document.querySelector('#job-details')!.insertAdjacentHTML('afterbegin', '<p>Staff engineer owning distributed systems in Go and Kubernetes.</p>')
  })
  await expect(page.locator('.jobs-search__job-details--container [data-zipply-pill="222"]')).toHaveText(/^\d+ · /, { timeout: 10_000 })
  await expect(page.locator('.jobs-search__job-details--container [data-zipply-pill]')).toHaveCount(1)
  await page.close()
})

test('Remembers a fix you made, for that site', async () => {
  const page = await context.newPage()
  const fill = () =>
    worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://boards.greenhouse.io/*' })
      await chrome.tabs.sendMessage(tab.id!, { type: 'fill', resumeId: null }, { frameId: 0 })
    })
  await page.goto('https://boards.greenhouse.io/globex/jobs/4012345')
  await page.waitForTimeout(1500)
  await fill()
  await expect(page.locator('#phone')).toHaveValue('(813) 555-0100')
  await page.fill('#phone', '+1 813 555 0199')
  await page.locator('#phone').blur()
  await page.waitForTimeout(800)

  await page.reload()
  await page.waitForTimeout(1500)
  await fill()
  await expect(page.locator('#phone')).toHaveValue('+1 813 555 0199')
  await page.close()
})

test('Profile page shows Status and copies diagnostics', async () => {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extId}/src/options/index.html#status`)
  const status = page.locator('#status')
  await expect(status.getByText('Google', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(status.getByText('Queue', { exact: true })).toBeVisible()
  await expect(status).toContainText(/Not signed in/)
  // Playwright can't grant clipboard access to extension pages; capture the write instead.
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (t: string) => void ((window as unknown as { __clip: string }).__clip = t)
  })
  await status.getByRole('button', { name: 'Copy diagnostics' }).click()
  await expect(status).toContainText('Copied.')
  const clip = await page.evaluate(() => (window as unknown as { __clip: string }).__clip)
  const d = JSON.parse(clip)
  expect(d.zipply).toBeTruthy()
  expect(clip).not.toMatch(/ada@example\.com|Globex|Lovelace/)
  await page.close()
})

test('Saves a form for testing, with nothing personal in it', async () => {
  const page = await context.newPage()
  await page.goto('https://boards.greenhouse.io/globex/jobs/4012345')
  await page.waitForTimeout(1500)
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://boards.greenhouse.io/*' }))[0].id)
  await page.fill('#first_name', 'Ada')
  await page.fill('#email', 'ada@example.com')
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html?tabId=${tabId}`)
  await expect(panel.getByRole('button', { name: 'Save form' })).toBeVisible({ timeout: 15_000 })
  const [download] = await Promise.all([panel.waitForEvent('download'), panel.getByRole('button', { name: 'Save form' }).click()])
  expect(download.suggestedFilename()).toMatch(/^zipply-form-boards\.greenhouse\.io-\d{4}-\d{2}-\d{2}\.html$/)
  const html = readFileSync(await download.path(), 'utf8')
  expect(html).toContain('id="first_name"')
  expect(html).not.toMatch(/ada@example\.com|Lovelace|value="Ada"/)
  await panel.close()
  await page.close()
})

test('Ranks all your resumes for a job and suggests the best', async () => {
  // A second resume: frontend, next to the data analyst PDF.
  const opts = await context.newPage()
  opts.on('pageerror', (e) => errors.push(e.message))
  await opts.goto(`chrome-extension://${extId}/src/options/index.html`)
  await opts.locator('#resumes input[type=file]').setInputFiles(join(FIX, 'resume-frontend.docx'))
  await expect(opts.locator('#resumes').getByText('resume-frontend.docx')).toBeVisible({ timeout: 15_000 })
  await expect(opts.locator('#resumes').getByText('Keep up to 10 versions', { exact: false })).toBeVisible()
  await opts.locator('#resumes input[placeholder="Tag"]').nth(1).fill('Frontend')

  // Paste a description on the Resumes page.
  const box = opts.locator('#resumes textarea')
  await box.fill('Frontend Engineer. Requirements: React, TypeScript, CSS and Node. Nice to have: Figma. You will build interfaces for millions of people.')
  await opts.getByRole('button', { name: 'Compare resumes' }).click()
  const ranking = opts.getByTestId('resume-ranking')
  await expect(ranking.locator('li')).toHaveCount(2)
  await expect(ranking.locator('li').first()).toContainText('Frontend')
  await expect(ranking.locator('li').first()).toContainText(/Best/)
  await expect(ranking).toContainText(/^.*Frontend scores \d+ points above resume\.pdf: it covers /)
  await box.fill('Data Analyst. Requirements: SQL, Python, Tableau and Excel. Nice to have: Pandas. You will build dashboards for operations teams.')
  await opts.getByRole('button', { name: 'Compare resumes' }).click()
  await expect(ranking.locator('li').first()).toContainText('resume.pdf')
  await opts.close()

  // The side panel on a Data Analyst posting: both resumes, PDF first, and you can switch.
  const page = await context.newPage()
  await page.goto('https://boards.greenhouse.io/globex/jobs/4012345')
  await page.waitForTimeout(1000)
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://boards.greenhouse.io/*' }))[0].id)
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html?tabId=${tabId}`)
  const rows = panel.getByTestId('resume-ranking').locator('li button')
  await expect(rows).toHaveCount(2, { timeout: 15_000 })
  await expect(rows.first()).toContainText('resume.pdf')
  await expect(rows.first()).toHaveAttribute('aria-pressed', 'true')
  await expect(rows.nth(1)).toContainText(/missing .*(SQL|Python|Tableau)/)
  await rows.nth(1).click()
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true')
  await panel.close()
  await page.close()

  // LinkedIn pills name the best resume and list the others on hover.
  const li = await context.newPage()
  await li.goto('https://www.linkedin.com/jobs/search/?currentJobId=111')
  const pillEl = li.locator('.jobs-search__job-details--container [data-zipply-pill="111"]')
  await expect(pillEl).toHaveText(/^\d+ · (Apply|Maybe|Skip) · resume\.pdf( · ✓ [^·]+)?$/, { timeout: 10_000 })
  await expect(pillEl.locator('span')).toHaveAttribute('title', /Best resume: resume\.pdf \(\d+\)\nOthers: Frontend \d+/)
  await li.close()
})

test('Holds 10 resumes, ranks all 10, and refuses an 11th', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zipply-resumes-'))
  const opts = await context.newPage()
  opts.on('pageerror', (e) => errors.push(e.message))
  await opts.goto(`chrome-extension://${extId}/src/options/index.html`)
  const section = opts.locator('#resumes')
  // Wait for the two resumes added earlier before counting.
  await expect(section.getByText('resume-frontend.docx')).toBeVisible({ timeout: 15_000 })
  const have = await section.locator('input[placeholder="Tag"]').count()
  expect(have).toBe(2)
  for (let i = have + 1; i <= 10; i++) {
    const f = join(dir, `resume-${i}.docx`)
    writeFileSync(f, readFileSync(join(FIX, 'resume-frontend.docx')))
    await section.locator('input[type=file]').first().setInputFiles(f)
    await expect(section.getByText(`resume-${i}.docx`)).toBeVisible({ timeout: 15_000 })
  }
  await expect(section.locator('input[placeholder="Tag"]')).toHaveCount(10)
  // Full: the add button goes away.
  await expect(section.getByText('Add a resume')).toHaveCount(0)

  await section.locator('textarea').fill('Data Analyst. Requirements: SQL, Python, Tableau and Excel. Nice to have: Pandas. You will build dashboards for operations teams.')
  await opts.getByRole('button', { name: 'Compare resumes' }).click()
  // The top 3 first; the rest on request.
  await expect(opts.getByTestId('resume-ranking').locator('li')).toHaveCount(3)
  await opts.getByRole('button', { name: 'Show all 10' }).click()
  await expect(opts.getByTestId('resume-ranking').locator('li')).toHaveCount(10)
  await expect(opts.getByTestId('resume-ranking').locator('li').first()).toContainText('resume.pdf')

  await opts.close()
})

const jobOf = (pattern: string) =>
  worker.evaluate(async (p) => {
    const tabs = await chrome.tabs.query({ url: p })
    if (!tabs.length) return null
    const key = `job:${tabs[tabs.length - 1].id}`
    return ((await chrome.storage.session.get(key))[key] as { posting: { title: string; company: string; description: string; url: string } } | undefined) ?? null
  }, pattern)

test('Keeps the job from a posting page through "Apply" to the form on another site', async () => {
  const form = readFileSync(join(FIX, 'custom.html'), 'utf8')
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Analytics Engineer', hiringOrganization: { '@type': 'Organization', name: 'Hooli' }, description: '<p>Requirements:</p><ul><li>SQL and dbt</li><li>Python</li></ul>' + '<p>You will own the warehouse models that every team reads from.</p>'.repeat(4) })
  await context.route('https://jobs.hooli.xyz/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<title>Analytics Engineer | Hooli</title><script type="application/ld+json">${ld}</script><h1>Analytics Engineer</h1><p>About the role.</p><a id="apply" href="https://apply.hooli-talent.net/form">Apply</a><a id="apply-new" target="_blank" href="https://apply.hooli-talent.net/form2">Apply in new tab</a>` }),
  )
  await context.route('https://apply.hooli-talent.net/**', (route) => route.fulfill({ contentType: 'text/html', body: form }))

  // Same tab: the posting page is remembered, then "Apply" goes to another site.
  const page = await context.newPage()
  await page.goto('https://jobs.hooli.xyz/analytics-engineer')
  await expect.poll(async () => (await jobOf('https://jobs.hooli.xyz/*'))?.posting.title, { timeout: 10_000 }).toBe('Analytics Engineer')
  await page.click('#apply')
  await page.waitForURL('https://apply.hooli-talent.net/form')
  await page.waitForTimeout(2000)
  const kept = await jobOf('https://apply.hooli-talent.net/*')
  // The form page's own heading ("Junior Data Engineer") doesn't replace the job.
  expect(kept?.posting).toMatchObject({ title: 'Analytics Engineer', company: 'Hooli' })
  expect(kept?.posting.description).toContain('warehouse models')

  // New tab: "Apply" that opens a tab carries the job over.
  await page.goto('https://jobs.hooli.xyz/analytics-engineer')
  await page.waitForTimeout(1000)
  const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#apply-new')])
  await popup.waitForURL('https://apply.hooli-talent.net/form2')
  await popup.waitForTimeout(1500)
  expect((await jobOf('https://apply.hooli-talent.net/form2'))?.posting).toMatchObject({ title: 'Analytics Engineer', company: 'Hooli' })
  await popup.close()
  await page.close()
})

test('Keeps the LinkedIn job when Apply goes to the company form', async () => {
  const page = await context.newPage()
  await page.goto('https://www.linkedin.com/jobs/search/?currentJobId=111')
  await expect.poll(async () => (await jobOf('https://www.linkedin.com/*'))?.posting.company, { timeout: 10_000 }).toBe('Globex')
  await page.goto('https://careers.initech.com/jobs/42')
  await page.waitForTimeout(2000)
  const kept = await jobOf('https://careers.initech.com/*')
  expect(kept?.posting).toMatchObject({ title: 'Data Analyst', company: 'Globex' })
  expect(kept?.posting.description).toContain('SQL and Python')
  await page.close()
})

test('Auto-fill carries on after Apply moves to another site', async () => {
  const page = await context.newPage()
  await page.goto('https://www.hooli.com/careers/apply')
  await page.waitForTimeout(1200)
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.hooli.com/*' })
    await chrome.tabs.sendMessage(tab.id!, { type: 'fill', resumeId: null }, { frameId: 0 })
  })
  await expect(page.locator('input[name="applicant_given"]')).toHaveValue('Ada')
  // Next step on a different site, same tab: fills without pressing Fill again.
  await page.goto('https://careers.initech.com/jobs/43')
  await expect(page.locator('input[name="applicant_given"]')).toHaveValue('Ada', { timeout: 10_000 })
  await expect(page.locator('input[name="contact"]')).toHaveValue('ada@example.com')
  // A tab you open separately (not from the filled one) stays untouched.
  const [other] = await Promise.all([
    context.waitForEvent('page'),
    worker.evaluate(() => chrome.tabs.create({ url: 'https://careers.initech.com/jobs/44' })),
  ])
  await other.waitForLoadState()
  await other.waitForTimeout(2500)
  await expect(other.locator('input[name="applicant_given"]')).toHaveValue('')
  await other.close()
  await page.close()
})

test('"Fill the application when it opens" on a posting page fills the form after Apply', async () => {
  const page = await context.newPage()
  await page.goto('https://jobs.hooli.xyz/analytics-engineer')
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://jobs.hooli.xyz/*' }))[0].id!)
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html?tabId=${tabId}`)
  await panel.getByRole('button', { name: 'Fill the application when it opens' }).click()
  await expect(panel.getByRole('button', { name: 'Will fill the application' })).toBeDisabled()
  await panel.close()

  // Same tab, another site.
  await page.click('#apply')
  await page.waitForURL('https://apply.hooli-talent.net/form')
  await expect(page.locator('input[name="applicant_given"]')).toHaveValue('Ada', { timeout: 10_000 })

  // Or a new tab, right after.
  await page.goto('https://jobs.hooli.xyz/analytics-engineer')
  const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#apply-new')])
  await expect(popup.locator('input[name="applicant_given"]')).toHaveValue('Ada', { timeout: 10_000 })
  await popup.close()
  await page.close()
})

test('A multi-step form that keeps changing and its address fills each step, and the panel keeps up', async () => {
  // Like Workday: a clock that never stops changing the page, and "Next" swaps
  // in a loading screen, then the next step, at the same address.
  const form = readFileSync(join(FIX, 'custom.html'), 'utf8').match(/<form>[\s\S]*<\/form>/)![0]
  await context.route('https://apply.stepco.net/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<title>Apply | Stepco</title><h1>Data Analyst</h1><span id="clock"></span><div id="step">${form}</div><button id="next">Next</button>
        <script>
          setInterval(() => { document.getElementById('clock').textContent = String(Date.now()) }, 100)
          document.getElementById('next').onclick = () => {
            document.getElementById('step').innerHTML = '<p>Loading…</p>'
            setTimeout(() => { document.getElementById('step').innerHTML = ${JSON.stringify(form)} }, 1500)
          }
        </script>`,
    }),
  )
  const page = await context.newPage()
  await page.goto('https://apply.stepco.net/apply')
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://apply.stepco.net/*' }))[0].id!)
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html?tabId=${tabId}`)
  await panel.getByRole('button', { name: 'Fill this page' }).click()
  await expect(page.locator('input[name="applicant_given"]')).toHaveValue('Ada', { timeout: 10_000 })

  await page.click('#next')
  // The loading screen has no form: the panel says so, then catches up when the step appears.
  await expect(panel.getByRole('button', { name: 'Will fill the application' })).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('input[name="applicant_given"]')).toHaveValue('Ada', { timeout: 10_000 })
  await expect(page.locator('input[name="contact"]')).toHaveValue('ada@example.com')
  await expect(panel.getByRole('button', { name: 'Fill this page' })).toBeEnabled({ timeout: 10_000 })
  await panel.close()
  await page.close()
})

test('"Since last time" is one line until you open it', async () => {
  const page = await context.newPage()
  await page.goto('https://jobs.lever.co/globex/1b2c3d4e/apply')
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://jobs.lever.co/*' }))[0].id!)
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html?tabId=${tabId}`)
  await panel.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('zipply')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction(['events', 'unlogged'], 'readwrite')
    for (let i = 0; i < 12; i++)
      tx.objectStore('events').put({ id: `e${i}`, appId: `a${i}`, company: `Company ${i}`, title: 'Analyst', from: 'Applied', to: 'Interview', at: Date.now() - i * 1000, seen: false, kind: 'change', note: '' })
    // Old news is left out.
    tx.objectStore('events').put({ id: 'old', appId: 'x', company: 'Old Co', title: 'Analyst', from: 'Applied', to: 'Rejected', at: Date.now() - 30 * 86_400_000, seen: false, kind: 'change', note: '' })
    await new Promise((r) => (tx.oncomplete = r))
    // Start collapsed (it remembers if you opened it before).
    localStorage.removeItem('zipply-since-open')
  })
  await panel.reload()
  const since = panel.getByTestId('since-last-time')
  await expect(since).toContainText('12 status updates', { timeout: 15_000 })
  await expect(panel.getByText('Company 0')).toHaveCount(0)
  await since.getByRole('button', { name: /Since last time/ }).click()
  await expect(panel.getByText('Company 0', { exact: true })).toBeVisible()
  await expect(panel.getByText('Company 5', { exact: true })).toHaveCount(0)
  await expect(panel.getByText('and 7 more')).toBeVisible()
  await expect(panel.getByText('Old Co')).toHaveCount(0)
  await since.getByRole('button', { name: 'Clear all' }).click()
  await expect(since).toHaveCount(0)
  await panel.close()
  await page.close()
})

test('Fills a tab holding a dead copy from before Zipply reloaded', async () => {
  // docs.google.com is excluded, so no content script loads there by itself:
  // the page ends up like a tab after an update, marked but with no live copy.
  await context.route('https://docs.google.com/forms/**', (r) => r.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, 'custom.html'), 'utf8') }))
  const page = await context.newPage()
  await page.goto('https://docs.google.com/forms/d/stale/viewform')
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://docs.google.com/*' }))[0].id!)
  // The marker an older build left behind.
  await worker.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => void ((window as { __zipply?: unknown }).__zipply = true) }), tabId)

  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html?tabId=${tabId}`)
  await panel.getByRole('button', { name: 'Fill this page' }).click({ timeout: 15_000 })
  await expect(page.locator('input[name="applicant_given"]')).toHaveValue('Ada', { timeout: 10_000 })
  await panel.close()
  await page.close()
})

test('The panel follows you through Handshake listings', async () => {
  await context.route('https://app.joinhandshake.com/**', (r) => r.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, 'handshake.html'), 'utf8') }))
  const page = await context.newPage()
  await page.goto('https://app.joinhandshake.com/job-search/111?page=1&per_page=25')
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://app.joinhandshake.com/*' }))[0].id!)
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html?tabId=${tabId}`)
  await expect(panel.getByText('Data Analyst', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByText('Globex', { exact: true }).first()).toBeVisible()
  // The clipped description is opened, and the listing gets a real score (not just the section count).
  await expect(page.locator('[data-hook="right-content"] button[aria-label^="Show less"]')).toHaveCount(1, { timeout: 10_000 })
  await expect(page.locator('[data-hook="right-content"] h1 [data-zipply-pill="111"]')).toHaveText(/^\d+ · /, { timeout: 10_000 })
  const pillText = (id: string) => page.locator(`[data-hook="right-content"] h1 [data-zipply-pill="${id}"]`).evaluate((el) => el.shadowRoot?.textContent ?? '')
  const first = await pillText('111')

  // Another listing: same page, new address, new pane. The panel catches up by itself.
  await page.click('[data-hook="job-result-card | 222"]')
  await expect(panel.getByText('Backend Engineer', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
  await expect(panel.getByText('Initech', { exact: true }).first()).toBeVisible()
  await expect(panel.getByText('Data Analyst', { exact: true })).toHaveCount(0)
  await expect(page.locator('[data-hook="right-content"] h1 [data-zipply-pill="222"]')).toHaveText(/^\d+ · /, { timeout: 10_000 })
  // Different jobs, different scores (the bug gave every job the same 15).
  expect(await pillText('222')).not.toBe(first)
  // And "Apply" from here carries the new job.
  const job = await worker.evaluate(async (id) => ((await chrome.storage.session.get(`job:${id}`))[`job:${id}`] as { posting: { title: string } }).posting.title, tabId)
  expect(job).toBe('Backend Engineer')
  await panel.close()
  await page.close()
})

test('Logs applications Handshake says you made', async () => {
  const applied = () =>
    worker.evaluate(
      () =>
        new Promise<{ company: string; title: string; dateApplied: string }[]>((res) => {
          const r = indexedDB.open('zipply')
          r.onsuccess = () => {
            const q = r.result.transaction('applied').objectStore('applied').getAll()
            q.onsuccess = () => res(q.result)
          }
        }),
    )
  const titles = async () => (await applied()).map((a) => `${a.company}: ${a.title}`)
  const today = await worker.evaluate(() => new Date().toLocaleDateString('en-CA'))

  // A job you applied to inside Handshake shows "Applied on …" and nothing else.
  await context.route('https://app.joinhandshake.com/**', (r) => r.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, 'handshake.html'), 'utf8') }))
  const page = await context.newPage()
  await page.goto('https://app.joinhandshake.com/job-search/333?page=1&per_page=25')
  await expect.poll(titles, { timeout: 15_000 }).toContain('Umbrella: ML Engineer')
  const row = (await applied()).find((a) => a.company === 'Umbrella')!
  expect(row.dateApplied).toBe(today)
  // Jobs you only looked at aren't logged.
  await page.click('[data-hook="job-result-card | 222"]')
  await page.waitForTimeout(2500)
  expect(await titles()).not.toContain('Initech: Backend Engineer')
  await page.close()

  // Your list of applications fills in the ones that were missed, once each,
  // and leaves out those from before you started tracking.
  await context.unroute('https://app.joinhandshake.com/**')
  await context.route('https://app.joinhandshake.com/**', (r) => r.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, 'handshake-apps.html'), 'utf8') }))
  const apps = await context.newPage()
  await apps.goto('https://app.joinhandshake.com/apps?page=1&per_page=25')
  await expect.poll(titles, { timeout: 15_000 }).toEqual(expect.arrayContaining(['Avery: Analyst', 'The Brite Group, Inc.: AI/ML Engineer']))
  await apps.reload()
  await apps.waitForTimeout(2500)
  const all = await titles()
  expect(all.filter((t) => t === 'Avery: Analyst')).toHaveLength(1)
  expect(all).not.toContain('Old Co: Data Analyst')
  await apps.close()
  await context.unroute('https://app.joinhandshake.com/**')
})

test('Fills a SmartRecruiters form whose fields are inside web components', async () => {
  await context.route('https://jobs.smartrecruiters.com/**', (r) => r.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, 'smartrecruiters.html'), 'utf8') }))
  await context.route('https://api.smartrecruiters.com/**', (r) =>
    r.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ id: '744000156841854', name: 'Data Analyst', company: { name: 'Globex' }, location: { fullLocation: 'Tampa, Florida, United States' }, jobAd: { sections: { jobDescription: { text: '<p>Build dashboards in Tableau on top of SQL, and automate reporting in Python.</p>' } } } }),
    }),
  )
  const page = await context.newPage()
  await page.goto('https://jobs.smartrecruiters.com/oneclick-ui/company/Globex/publication/273278e1-db5f-42fc-b185-71d233cc85b5')
  // Seen as an application (the toolbar dot), though no input is outside a shadow root.
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://jobs.smartrecruiters.com/*' }))[0].id!)
  await expect.poll(() => worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId), { timeout: 10_000 }).toBe(' ')

  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html?tabId=${tabId}`)
  // The job comes from SmartRecruiters' API.
  await expect(panel.getByText('Data Analyst', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await panel.getByRole('button', { name: 'Fill this page' }).click({ timeout: 15_000 })
  const inner = (id: string) => page.locator(`:not(input, textarea)#${id}`).first().evaluate((h) => (h.shadowRoot!.querySelector('input, textarea') as HTMLInputElement).value)
  await expect.poll(() => inner('first-name-input'), { timeout: 10_000 }).toBe('Ada')
  await expect.poll(() => inner('last-name-input'), { timeout: 10_000 }).toBe('Lovelace')
  await expect.poll(() => inner('confirm-email-input'), { timeout: 10_000 }).toBe('ada@example.com')
  await expect.poll(() => page.locator('spl-autocomplete#city-input').evaluate((h) => (h as HTMLElement).dataset.selected ?? ''), { timeout: 10_000 }).toMatch(/^Tampa/)
  await panel.close()
  await page.close()
  await context.unroute('https://jobs.smartrecruiters.com/**')
  await context.unroute('https://api.smartrecruiters.com/**')
})

test('No console errors on extension pages', () => {
  expect(errors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND/.test(e))).toEqual([])
})

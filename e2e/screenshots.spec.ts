// README screenshots (docs/images), made with the fictional test profile.
// Skipped in normal runs; regenerate with `npm run screenshots`.
import { test, expect, chromium } from '@playwright/test'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(import.meta.dirname, '..')
const FIX = join(ROOT, 'tests', 'fixtures')
const OUT = join(ROOT, 'docs', 'images')

test('screenshots', async () => {
  test.skip(!process.env.SHOTS, 'Set SHOTS=1 to regenerate the README screenshots')
  test.setTimeout(120_000)
  const DIST = join(ROOT, 'dist')
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'zs-')), { channel: 'chromium', headless: true, colorScheme: 'light', args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`] })
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const extId = new URL(sw.url()).host
  const desc = `<p>Globex helps hospitals plan staffing. You'll join a four-person analytics team that turns scheduling data into decisions for operations leaders.</p>
<p>Requirements:</p><ul><li>2+ years of SQL and Python</li><li>Dashboards in Tableau</li><li>Strong Excel</li></ul>
<p>Nice to have: dbt, Snowflake.</p><p>Salary: $78,000 to $92,000. Hybrid in Tampa, FL. Full-time.</p>`
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Data Analyst', datePosted: new Date().toISOString().slice(0, 10), employmentType: 'FULL_TIME', hiringOrganization: { '@type': 'Organization', name: 'Globex' }, jobLocation: { '@type': 'Place', address: { addressLocality: 'Tampa', addressRegion: 'FL' } }, baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 78000, maxValue: 92000, unitText: 'YEAR' } }, description: desc })
  await context.route('https://careers.globex.com/**', (r) => r.fulfill({ contentType: 'text/html', body: `<title>Data Analyst | Globex</title><script type="application/ld+json">${ld}</script><h1>Data Analyst</h1>${desc}<a href="https://boards.greenhouse.io/globex/jobs/4012345">Apply</a>` }))
  await context.route('https://boards.greenhouse.io/**', (r) => r.fulfill({ contentType: 'text/html', body: readFileSync(join(FIX, 'greenhouse.html'), 'utf8') }))

  // Profile and two tagged resumes.
  const opts = await context.newPage()
  await opts.goto(`chrome-extension://${extId}/src/options/index.html`)
  const file = join(mkdtempSync(join(tmpdir(), 'zp-')), 'profile.json')
  writeFileSync(file, JSON.stringify({ format: 'zipply-profile', version: 1, exportedAt: new Date().toISOString(), profile: {
    basics: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '(813) 555-0100', city: 'Tampa', state: 'FL', country: 'United States', headline: 'Data analyst' },
    links: { linkedin: 'https://linkedin.com/in/ada', github: 'https://github.com/ada', portfolio: '', other: '' },
    work: [{ id: 'w1', title: 'Data Analyst Intern', company: 'Acme Corp', location: 'Tampa, FL', start: '2025-05', end: '2025-08', current: false, description: 'Built Tableau dashboards on SQL. Automated weekly reporting in Python.' }],
    education: [{ id: 'e1', school: 'University of South Florida', degree: "Bachelor's", major: 'Computer Science', start: '2022-08', end: '2026-05', gpa: '' }],
    skills: ['Python', 'SQL', 'Tableau', 'Excel', 'Pandas'],
    answers: { workAuthorized: 'Yes', needsSponsorship: 'No', relocate: 'Yes' },
  }, answerBank: [], resumes: [] }))
  await opts.locator('#privacy input[type=file]').setInputFiles(file)
  await expect(opts.getByText('Imported.')).toBeVisible()
  await opts.reload()
  const res = opts.locator('#resumes')
  await res.locator('input[type=file]').first().setInputFiles(join(FIX, 'resume.pdf'))
  await expect(res.getByText('resume.pdf')).toBeVisible({ timeout: 15_000 })
  await res.locator('input[type=file]').first().setInputFiles(join(FIX, 'resume-frontend.docx'))
  await expect(res.getByText('resume-frontend.docx')).toBeVisible({ timeout: 15_000 })
  await res.locator('input[placeholder="Tag"]').nth(0).fill('Data')
  await res.locator('input[placeholder="Tag"]').nth(1).fill('Frontend')
  await opts.waitForTimeout(800)
  await opts.setViewportSize({ width: 1100, height: 760 })
  await opts.goto(`chrome-extension://${extId}/src/options/index.html#resumes`)
  await opts.waitForTimeout(1200)
  await opts.locator('#resumes textarea').fill('Data Analyst. Requirements: SQL, Python, Tableau and Excel. Nice to have: dbt. You will build dashboards for operations teams.')
  await opts.getByRole('button', { name: 'Compare resumes' }).click()
  await opts.waitForTimeout(500)
  await opts.locator('#resumes').screenshot({ path: join(OUT, 'resumes.png') })
  await opts.close()

  // Side panel on the posting.
  const page = await context.newPage()
  await page.goto('https://careers.globex.com/jobs/data-analyst')
  await page.waitForTimeout(1500)
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://careers.globex.com/*' }))[0].id!)
  const panel = await context.newPage()
  await panel.setViewportSize({ width: 380, height: 1000 })
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html?tabId=${tabId}`)
  await expect(panel.getByRole('button', { name: 'Fill the application when it opens' })).toBeVisible({ timeout: 15_000 })
  await panel.waitForTimeout(800)
  await panel.screenshot({ path: join(OUT, 'panel-posting.png'), fullPage: true })
  await panel.getByRole('button', { name: 'Fill the application when it opens' }).click()

  // Apply: the form fills as it opens; the panel shows what was filled.
  await page.click('a')
  await page.waitForURL('https://boards.greenhouse.io/**')
  await expect(page.locator('#first_name')).toHaveValue('Ada', { timeout: 15_000 })
  await panel.reload()
  await expect(panel.getByRole('button', { name: 'Fill this page' })).toBeVisible({ timeout: 15_000 })
  await panel.getByRole('button', { name: 'Fill this page' }).click()
  await expect(panel.getByText(/filled/).first()).toBeVisible({ timeout: 15_000 })
  await panel.waitForTimeout(800)
  await panel.screenshot({ path: join(OUT, 'panel-filled.png'), fullPage: true })
  await context.close()
})

// Renders public/icons/logo.svg (and logo-small.svg, for the toolbar sizes)
// to the PNGs the manifest uses. Run: node scripts/icons.mjs
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const dir = new URL('../public/icons/', import.meta.url)
const sizes = { 16: 'logo-small.svg', 32: 'logo-small.svg', 48: 'logo.svg', 128: 'logo.svg' }

const browser = await chromium.launch()
for (const [size, file] of Object.entries(sizes)) {
  const svg = readFileSync(new URL(file, dir), 'utf8')
  const page = await browser.newPage({ viewport: { width: Number(size), height: Number(size) } })
  await page.setContent(`<body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`)
  await page.screenshot({ path: new URL(`icon-${size}.png`, dir).pathname, omitBackground: true })
  await page.close()
}
await browser.close()

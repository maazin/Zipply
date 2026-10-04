/*
 * ATS readability checks adapted from ai-job-search (https://github.com/MadsLorentzen/ai-job-search)
 * .claude/commands/apply.md step 5d "ATS & keyword verification", MIT, and the
 * section check from Resume-Matcher's ats.py (Apache-2.0). Modified: pdf.js text
 * items (with positions) replace pdftotext, so reading order can be measured.
 */
import type { AtsCheck, AtsReport, PageLayout, ResumeContent } from '@/shared/types'
import { detectSections } from './matchScore'
import { hasSkill, skillDef, type Keyword } from './keywords'

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/
const PHONE = /(\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/

export function pageText(p: PageLayout): string {
  return p.items.map((i) => i.str).join(' ')
}

/** Characters an ATS can't read: replacement chars, private use, ligatures, (cid:N). */
export function brokenCharRatio(text: string): number {
  if (!text.length) return 1
  let bad = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c === 0xfffd || (c >= 0xe000 && c <= 0xf8ff) || (c >= 0xfb00 && c <= 0xfb06)) bad++
  }
  bad += (text.match(/\(cid:\d+\)/g) ?? []).length * 6
  return bad / text.length
}

interface Segment {
  y: number
  x: number
  end: number
  text: string
}

/** Merge neighbouring items on the same baseline into segments, keeping stream order. */
export function segmentsOf(p: PageLayout): Segment[] {
  const segs: Segment[] = []
  for (const it of p.items) {
    if (!it.str.trim()) continue
    const last = segs[segs.length - 1]
    const sameLine = last && Math.abs(last.y - it.y) <= Math.max(2, it.h * 0.4)
    if (last && sameLine && it.x - last.end < Math.max(20, it.h * 2)) {
      last.text += ' ' + it.str
      last.end = Math.max(last.end, it.x + it.w)
    } else segs.push({ y: it.y, x: it.x, end: it.x + it.w, text: it.str })
  }
  return segs
}

/**
 * Count how often the extracted order jumps between the left and right halves of
 * the page. A clean single column, or two columns read one after the other,
 * switches once or twice. Interleaved columns switch on almost every line.
 * Short right-hand fragments (dates, locations) are ignored, since single-column
 * resumes right-align them.
 */
export function columnSwitches(p: PageLayout): { switches: number; left: number; right: number } {
  const mid = p.width / 2
  let switches = 0
  let left = 0
  let right = 0
  let prev: 'L' | 'R' | null = null
  for (const s of segmentsOf(p)) {
    const side = s.x < mid - p.width * 0.05 ? 'L' : 'R'
    if (side === 'R' && s.text.trim().length < 35) continue
    if (side === 'L') left++
    else right++
    if (prev && side !== prev) switches++
    prev = side
  }
  return { switches, left, right }
}

/** Text in the top or bottom 4% of a page, where headers and footers live. */
function bodyText(p: PageLayout): string {
  const top = p.height * 0.96
  const bottom = p.height * 0.04
  return p.items
    .filter((i) => i.y < top && i.y > bottom)
    .map((i) => i.str)
    .join(' ')
}

export function atsReport(content: ResumeContent, keywords?: Keyword[]): AtsReport {
  const checks: AtsCheck[] = []
  const pages = content.pages
  const text = content.text

  // 1. Text layer
  if (pages && pages.length) {
    const thin = pages.findIndex((p) => pageText(p).replace(/\s+/g, '').length < 200)
    checks.push(
      thin >= 0
        ? { name: 'Text layer', pass: false, reason: `Page ${thin + 1} has under 200 characters of text; it may be a scanned image` }
        : { name: 'Text layer', pass: true, reason: 'Every page has a text layer' },
    )
  } else {
    const ok = text.replace(/\s+/g, '').length >= 200
    checks.push({ name: 'Text layer', pass: ok, reason: ok ? 'Text extracted' : 'Under 200 characters of text found' })
  }
  const noText = checks[0].pass === false && text.replace(/\s+/g, '').length < 50

  // 2. Contact details as plain body text
  const body = pages?.length ? pages.map(bodyText).join('\n') : text
  const hasEmail = EMAIL.test(body)
  const hasPhone = PHONE.test(body)
  const onlyInHeader = !hasEmail && content.headerFooterText ? EMAIL.test(content.headerFooterText) : false
  checks.push({
    name: 'Contact details',
    pass: hasEmail && hasPhone,
    reason:
      hasEmail && hasPhone
        ? 'Email and phone found as text'
        : onlyInHeader
          ? 'Email is only in the page header, which many ATS skip'
          : `${[!hasEmail && 'Email', !hasPhone && 'Phone'].filter(Boolean).join(' and ')} not found as plain text (icons or links don't count)`,
  })

  // 3. Clean characters
  const ratio = brokenCharRatio(text)
  checks.push({
    name: 'Clean characters',
    pass: ratio < 0.01,
    reason: ratio < 0.01 ? 'No broken characters' : `${(ratio * 100).toFixed(1)}% broken, private-use or ligature characters (like "ﬁ")`,
  })

  // 4. Reading order
  if (pages?.length) {
    const bad = pages
      .map((p, i) => ({ i, ...columnSwitches(p) }))
      .find((r) => r.switches > 4 && r.left >= 5 && r.right >= 5)
    checks.push(
      bad
        ? { name: 'Reading order', pass: false, reason: `Page ${bad.i + 1} jumps between two columns ${bad.switches} times` }
        : { name: 'Reading order', pass: true, reason: 'Lines read top to bottom' },
    )
  } else {
    checks.push({ name: 'Reading order', pass: true, reason: 'Word documents read in order' })
  }

  // 5. Sections
  const s = detectSections(text)
  const missing = (['experience', 'education', 'skills'] as const).filter((k) => !s[k])
  checks.push({
    name: 'Sections',
    pass: missing.length === 0,
    reason: missing.length ? `No ${missing.map((m) => m[0].toUpperCase() + m.slice(1)).join(', ')} heading found` : 'Experience, Education and Skills found',
  })

  // 6. Keyword coverage, measured on what the parser actually sees
  if (keywords?.length) {
    const req = keywords.filter((k) => k.tier === 'required')
    const pool = req.length ? req : keywords.slice(0, 10)
    const hit = pool.filter((k) => hasSkill(skillDef(k.term) ?? k.term, text)).length
    const pct = Math.round((hit / pool.length) * 100)
    checks.push({
      name: 'Keyword coverage',
      pass: pct >= 60,
      reason: `${hit} of ${pool.length} ${req.length ? 'required ' : ''}keywords readable in the text (${pct}%)`,
    })
  } else {
    checks.push({ name: 'Keyword coverage', pass: null, reason: 'Open a posting to check' })
  }

  const failed = checks.filter((c) => c.pass === false).length
  const grade = noText || failed >= 3 ? 'Broken' : failed ? 'Fix' : 'Good'
  return { grade, checks }
}

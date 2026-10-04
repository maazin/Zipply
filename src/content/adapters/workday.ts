// Workday: multi-page wizard, custom dropdowns and date pickers, and repeating
// work/education blocks. Keyed on data-automation-id, which is stable across
// tenants. Never clicks Next or Submit; only "Add" inside work and education.
import type { EducationEntry, FieldReport, Profile, WorkEntry } from '@/shared/types'
import type { ProfileKey } from '@/shared/profileKeys'
import type { Adapter, RepeatResult } from './types'
import { genericConfirmation, mapBy } from './types'
import { collectFields, labelFor, type Collected } from '../dom/collect'
import { humanPause, setChecked, setCombobox, setText, sleep } from '../dom/setValue'
import { fetchPosting, textAt } from '../posting'

const aid = (el: Element | null) => el?.getAttribute('data-automation-id') ?? ''

function attrs(c: Collected): string {
  const wrap = c.el.closest('[data-automation-id^="formField-"]')
  return [aid(c.el), c.el.id, c.desc.name, aid(wrap)].join(' ')
}

const RULES: [RegExp, ProfileKey][] = [
  [/preferredName.*firstName|preferredName--firstName/i, 'preferredName'],
  [/legalNameSection_firstName|legalName--firstName|formField-firstName/i, 'firstName'],
  [/legalNameSection_lastName|legalName--lastName|formField-lastName/i, 'lastName'],
  [/(^|\s)email(\s|$)|email--email|formField-email/i, 'email'],
  [/phone-number|phoneNumber--phoneNumber|formField-phoneNumber/i, 'phone'],
  [/addressSection_addressLine1|address--addressLine1|formField-addressLine1/i, 'addressLine1'],
  [/addressSection_city|address--city|formField-city/i, 'city'],
  [/addressSection_postalCode|address--postalCode|formField-postalCode/i, 'postalCode'],
  [/addressSection_countryRegion|address--countryRegion|formField-countryRegion/i, 'state'],
  [/countryDropdown|country--country|formField-country(\s|$)/i, 'country'],
  [/sourceDropdown|source--source|formField-source/i, 'howDidYouHear'],
  [/linkedin/i, 'linkedin'],
  [/file-upload-input-ref/i, 'resume'],
  [/gender/i, 'gender'],
  [/ethnicity|race/i, 'race'],
  [/hispanic/i, 'hispanic'],
  [/veteran/i, 'veteran'],
  [/disability/i, 'disability'],
]

/** "Posted 30+ Days Ago" → an ISO date (approximate). */
export function postedOn(text: string, now = new Date()): string {
  const t = text.toLowerCase()
  let days: number | null = null
  if (/today/.test(t)) days = 0
  else if (/yesterday/.test(t)) days = 1
  else {
    const m = t.match(/(\d+)\+?\s*days?/)
    if (m) days = Number(m[1])
  }
  if (days == null) return ''
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
}

// ---------- repeating sections ----------

type Sub = 'title' | 'company' | 'location' | 'current' | 'description' | 'school' | 'degree' | 'major' | 'gpa'

const WORK_SUBS: [RegExp, Sub][] = [
  [/job title|^title/i, 'title'],
  [/company|employer/i, 'company'],
  [/location/i, 'location'],
  [/currently work|i currently/i, 'current'],
  [/role description|description|responsibilit/i, 'description'],
]

const EDU_SUBS: [RegExp, Sub][] = [
  [/school|university|institution/i, 'school'],
  [/degree/i, 'degree'],
  [/field of study|major|discipline/i, 'major'],
  [/gpa|overall result|grade average/i, 'gpa'],
]

function findSection(doc: Document, automationId: string, heading: RegExp): HTMLElement | null {
  const byId = doc.querySelector<HTMLElement>(`[data-automation-id="${automationId}"]`)
  if (byId) return byId
  for (const h of Array.from(doc.querySelectorAll<HTMLElement>('h2, h3, h4, legend, [role="heading"]'))) {
    if (heading.test((h.textContent ?? '').trim())) {
      return h.closest<HTMLElement>('[role="group"], fieldset, section') ?? h.parentElement
    }
  }
  return null
}

function addButton(section: HTMLElement): HTMLButtonElement | null {
  return (
    section.querySelector<HTMLButtonElement>('button[data-automation-id="add-button"]') ??
    Array.from(section.querySelectorAll<HTMLButtonElement>('button')).find((b) => /^\s*add( another)?\s*$/i.test(b.textContent ?? '')) ??
    null
  )
}

/** One block per anchor field (job title or school), found by climbing until a sibling anchor appears. */
function blocks(section: HTMLElement, anchor: RegExp): HTMLElement[] {
  const anchors = collectFields(section).filter((c) => anchor.test(c.desc.label) || anchor.test(attrs(c)))
  return anchors.map((a) => {
    let node: HTMLElement = a.el
    while (node.parentElement && node.parentElement !== section && anchors.filter((x) => node.parentElement!.contains(x.el)).length === 1) node = node.parentElement
    return node
  })
}

async function ensureBlocks(section: HTMLElement, anchor: RegExp, want: number): Promise<HTMLElement[]> {
  let have = blocks(section, anchor)
  for (let tries = 0; have.length < want && tries < want + 1; tries++) {
    const btn = addButton(section)
    if (!btn) break
    btn.click()
    await sleep(500)
    have = blocks(section, anchor)
  }
  return have.slice(0, want)
}

function month(ym: string): string {
  return ym.length >= 7 ? ym.slice(5, 7) : ''
}

/** Workday dates are separate month/year inputs inside a "From"/"To" group. */
async function fillDate(block: HTMLElement, which: 'start' | 'end', ym: string): Promise<boolean> {
  if (!ym) return false
  const groups = Array.from(block.querySelectorAll<HTMLElement>(`[data-automation-id="formField-${which}Date"], [data-automation-id*="${which}Date" i], [role="group"]`)).filter((g) =>
    which === 'start' ? /start|from|first year/i.test(aid(g) + ' ' + (g.getAttribute('aria-label') ?? '') + ' ' + labelFor(g)) : /end|to\b|last year|graduat/i.test(aid(g) + ' ' + (g.getAttribute('aria-label') ?? '') + ' ' + labelFor(g)),
  )
  for (const g of groups) {
    const m = g.querySelector<HTMLInputElement>('[data-automation-id="dateSectionMonth-input"], input[aria-label*="Month" i]')
    const y = g.querySelector<HTMLInputElement>('[data-automation-id="dateSectionYear-input"], input[aria-label*="Year" i]')
    if (y) {
      if (m && month(ym)) {
        setText(m, month(ym))
        await humanPause()
      }
      setText(y, ym.slice(0, 4))
      return true
    }
    const single = g.querySelector<HTMLInputElement>('input')
    if (single) {
      setText(single, month(ym) ? `${month(ym)}/${ym.slice(0, 4)}` : ym.slice(0, 4))
      return true
    }
  }
  return false
}

async function fillBlock(
  block: HTMLElement,
  subs: [RegExp, Sub][],
  values: Partial<Record<Sub, string | boolean>>,
  dates: { start: string; end: string },
  prefix: string,
  reports: FieldReport[],
  handled: Set<string>,
) {
  for (const c of collectFields(block)) {
    const label = c.desc.label || c.desc.ariaLabel
    handled.add(c.desc.zid)
    if (/month|year/i.test(label) && c.desc.kind !== 'combobox') continue
    const sub = subs.find(([re]) => re.test(label))?.[1]
    if (!sub) continue
    const v = values[sub]
    const report: FieldReport = { zid: c.desc.zid, label: `${prefix}: ${label}`, status: 'skipped', source: 'adapter', required: c.desc.required, missing: false }
    if (sub === 'current') {
      if (c.desc.kind === 'checkbox') {
        setChecked(c.el as HTMLInputElement, Boolean(v))
        report.status = 'filled'
      }
    } else if (typeof v === 'string' && v) {
      if (c.desc.kind === 'combobox') {
        const chosen = await setCombobox(c.el as HTMLElement, v)
        report.status = chosen ? 'low' : 'skipped'
        if (!chosen) report.reason = `No option matches "${v}"`
      } else if (c.desc.kind !== 'file') {
        setText(c.el as HTMLElement, v)
        report.status = 'filled'
      }
    } else report.reason = 'Empty in your profile'
    reports.push(report)
    await humanPause()
  }
  for (const which of ['start', 'end'] as const) {
    if (which === 'end' && values.current) continue
    const ok = await fillDate(block, which, dates[which])
    if (dates[which]) reports.push({ zid: '', label: `${prefix}: ${which === 'start' ? 'From' : 'To'}`, status: ok ? 'filled' : 'skipped', source: 'adapter', required: false, missing: false, reason: ok ? undefined : 'Date field not found' })
  }
}

async function fillRepeating(profile: Profile, doc: Document): Promise<RepeatResult> {
  const reports: FieldReport[] = []
  const handled = new Set<string>()
  const excludeKeys: ProfileKey[] = []

  const work = findSection(doc, 'workExperienceSection', /^work experience/i)
  if (work && profile.work.length) {
    excludeKeys.push('currentCompany', 'currentTitle')
    const list: WorkEntry[] = profile.work.slice(0, 6)
    const bs = await ensureBlocks(work, /job title|jobTitle/i, list.length)
    for (let i = 0; i < bs.length; i++) {
      const w = list[i]
      await fillBlock(bs[i], WORK_SUBS, { title: w.title, company: w.company, location: w.location, current: w.current, description: w.description }, { start: w.start, end: w.end }, `Work ${i + 1}`, reports, handled)
    }
  }

  const edu = findSection(doc, 'educationSection', /^education/i)
  if (edu && profile.education.length) {
    excludeKeys.push('school', 'degree', 'major', 'gradYear', 'gpa')
    const list: EducationEntry[] = profile.education.slice(0, 4)
    const bs = await ensureBlocks(edu, /school|university|institution/i, list.length)
    for (let i = 0; i < bs.length; i++) {
      const e = list[i]
      await fillBlock(bs[i], EDU_SUBS, { school: e.school, degree: e.degree, major: e.major, gpa: e.gpa }, { start: e.start, end: e.end }, `Education ${i + 1}`, reports, handled)
    }
  }
  return { reports, handled, excludeKeys }
}

export const workday: Adapter = {
  name: 'Workday',
  hosts: /(^|\.)(myworkdayjobs|myworkday)\.com$/,
  detect: (url, doc) => /myworkdayjobs\.com$|myworkday\.com$/.test(url.hostname) || Boolean(doc.querySelector('[data-automation-id="applyFlowPage"], [data-automation-id="jobPostingHeader"]')),

  explicit: (fields) => mapBy(fields, RULES, attrs),

  async posting(doc, url) {
    const title = doc.querySelector('[data-automation-id="jobPostingHeader"]')?.textContent?.trim() ?? ''
    const reqText = doc.querySelector('[data-automation-id="requisitionId"]')?.textContent ?? ''
    const fromUrl = url.pathname.match(/_([A-Z]*-?\d[\w-]*)(?:\/|$)/)?.[1] ?? ''
    let description = textAt(doc, ['[data-automation-id="jobPostingDescription"]'])
    let ld: Awaited<ReturnType<typeof fetchPosting>> = null
    if (!description && /\/apply/.test(url.pathname)) {
      ld = await fetchPosting(url.href.replace(/\/apply.*$/, ''))
      description = ld?.ld?.description ?? ''
    }
    const tenant = url.hostname.split('.')[0]
    return {
      title: title || ld?.ld?.title || '',
      company: ld?.ld?.company || tenant.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      location: doc.querySelector('[data-automation-id="locations"] dd, [data-automation-id="locations"]')?.textContent?.replace(/^locations/i, '').trim() ?? '',
      description,
      datePosted: postedOn(doc.querySelector('[data-automation-id="postedOn"]')?.textContent ?? ''),
      jobId: reqText.replace(/^.*?(id|number)\s*/i, '').trim() || fromUrl,
    }
  },

  isConfirmation: (doc) =>
    Boolean(doc.querySelector('[data-automation-id*="congratulation" i], [data-automation-id="applicationSubmitted"]')) || genericConfirmation(doc),

  fillRepeating,
}

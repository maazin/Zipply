// Rule-based resume parsing: split sections by headings, then pull fields out
// with patterns. Idea (not code) from OpenResume's in-browser parser.
import type { Basics, EducationEntry, Links, WorkEntry } from '@/shared/types'
import { uid } from '@/shared/defaults'

export interface ParsedResume {
  basics: Partial<Basics>
  links: Partial<Links>
  work: WorkEntry[]
  education: EducationEntry[]
  skills: string[]
}

type Section = 'header' | 'summary' | 'experience' | 'education' | 'skills' | 'projects' | 'other'

const HEADINGS: [Section, RegExp][] = [
  ['summary', /^(summary|professional summary|profile|objective|about( me)?)$/i],
  ['experience', /^(experience|work experience|professional experience|employment( history)?|work history|relevant experience)$/i],
  ['education', /^(education|academic background|education and training|academics)$/i],
  ['skills', /^(skills|technical skills|skills (and|&) (tools|technologies|interests)|core competencies|technologies|tools)$/i],
  ['projects', /^(projects|personal projects|selected projects|academic projects)$/i],
  ['other', /^(certifications?|awards|honors|publications|volunteer(ing)?|leadership|activities|interests|languages|references)$/i],
]

export function splitSections(text: string): Record<Section, string[]> {
  const out: Record<Section, string[]> = { header: [], summary: [], experience: [], education: [], skills: [], projects: [], other: [] }
  let cur: Section = 'header'
  for (const raw of text.split(/\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line) continue
    const head = line.replace(/[:•|]+$/, '').trim()
    const hit = head.length <= 45 ? HEADINGS.find(([, re]) => re.test(head)) : undefined
    if (hit) {
      cur = hit[0]
      continue
    }
    out[cur].push(line)
  }
  return out
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
}

/** "Jan 2022", "01/2022", "2022" → "2022-01" / "2022" */
export function parseDate(s: string): string {
  const t = s.trim().toLowerCase()
  let m = t.match(/^([a-z]{3,9})\.?\s+(\d{4})$/)
  if (m && MONTHS[m[1].slice(0, 4)] ) return `${m[2]}-${MONTHS[m[1].slice(0, 4)]}`
  if (m && MONTHS[m[1].slice(0, 3)]) return `${m[2]}-${MONTHS[m[1].slice(0, 3)]}`
  m = t.match(/^(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`
  m = t.match(/^(\d{4})$/)
  if (m) return m[1]
  return ''
}

const DATE = String.raw`(?:[A-Za-z]{3,9}\.?\s+\d{4}|\d{1,2}/\d{4}|\d{4})`
const RANGE = new RegExp(String.raw`(${DATE})\s*(?:-|–|—|to)\s*(${DATE}|present|current|now)`, 'i')

function splitTitleCompany(line: string): { title: string; company: string; location: string } {
  const parts = line.split(/\s*[|–—]\s*|\s+-\s+|,\s+|\s+@\s+|\s+at\s+/).map((s) => s.trim()).filter(Boolean)
  if (parts.length >= 3) return { title: parts[0], company: parts[1], location: parts.slice(2).join(', ') }
  if (parts.length === 2) return { title: parts[0], company: parts[1], location: '' }
  return { title: line, company: '', location: '' }
}

export function parseWork(lines: string[]): WorkEntry[] {
  const out: WorkEntry[] = []
  let cur: WorkEntry | null = null
  // Plain lines wait here: a date range next makes them the job header,
  // a bullet next makes them part of the current description.
  let pending: string[] = []
  const flushToDescription = () => {
    if (cur && pending.length) cur.description += (cur.description ? '\n' : '') + pending.join('\n')
    pending = []
  }
  for (const line of lines) {
    const r = line.match(RANGE)
    if (r) {
      const before = line.replace(RANGE, '').replace(/[|,–—-]\s*$/, '').trim()
      const header = [...pending.slice(-2), before].filter(Boolean)
      const { title, company, location } = header.length >= 2 ? { ...splitTitleCompany(header[0]), ...pick2(header) } : splitTitleCompany(header[0] ?? '')
      const end = /present|current|now/i.test(r[2]) ? '' : parseDate(r[2])
      if (pending.length > 2) {
        pending = pending.slice(0, -2)
        flushToDescription()
      }
      cur = { id: uid(), title, company, location, start: parseDate(r[1]), end, current: !end, description: '' }
      out.push(cur)
      pending = []
      continue
    }
    if (/^[•\-*▪◦●]\s*/.test(line)) {
      flushToDescription()
      if (cur) cur.description += (cur.description ? '\n' : '') + line.replace(/^[•\-*▪◦●]\s*/, '- ')
    } else pending.push(line)
  }
  flushToDescription()
  return out.filter((w) => w.title || w.company)
}

function pick2(lines: string[]): { title: string; company: string; location: string } {
  const a = splitTitleCompany(lines[0])
  const b = splitTitleCompany(lines[1])
  // Usually "Company, City" then "Title", or "Title" then "Company".
  if (!a.company && !b.company) return { title: lines[1], company: lines[0], location: '' }
  return { title: a.title, company: a.company || b.title, location: a.location || b.location }
}

const DEGREE = /\b(B\.?S\.?|B\.?A\.?|BSc|M\.?S\.?|M\.?A\.?|MSc|MBA|Ph\.?D\.?|Bachelor(?:'s)?|Master(?:'s)?|Associate(?:'s)?|Doctor(?:ate)?)\b[^,|\n]*/i
const SCHOOL = /\b(University|College|Institute|School|Academy|Polytechnic)\b/i

export function parseEducation(lines: string[]): EducationEntry[] {
  const out: EducationEntry[] = []
  let cur: EducationEntry | null = null
  for (const line of lines) {
    const isSchool = SCHOOL.test(line)
    if (isSchool && (!cur || cur.school)) {
      cur = { id: uid(), school: line.replace(RANGE, '').split(/\s+[|–—]\s+|,\s(?=[A-Z][a-z]+,?\s[A-Z]{2}\b)/)[0].trim(), degree: '', major: '', start: '', end: '', gpa: '' }
      out.push(cur)
    }
    if (!cur) {
      cur = { id: uid(), school: '', degree: '', major: '', start: '', end: '', gpa: '' }
      out.push(cur)
    }
    const d = line.match(DEGREE)
    if (d && !cur.degree) {
      const full = d[0].trim()
      const [deg, major] = full.split(/\s+in\s+|,\s*/i)
      cur.degree = deg.trim()
      cur.major = (major ?? '').replace(RANGE, '').trim()
    }
    const r = line.match(RANGE)
    if (r) {
      cur.start = parseDate(r[1])
      cur.end = /present|current|now/i.test(r[2]) ? '' : parseDate(r[2])
    } else {
      const single = line.match(new RegExp(String.raw`(?:expected|graduat\w*|class of)?\s*(${DATE})\s*$`, 'i'))
      if (single && !cur.end) cur.end = parseDate(single[1])
    }
    const g = line.match(/GPA[:\s]*([0-4]\.\d{1,2})/i)
    if (g) cur.gpa = g[1]
  }
  return out.filter((e) => e.school || e.degree)
}

export function parseSkills(lines: string[]): string[] {
  const out = new Set<string>()
  for (const line of lines) {
    const body = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line
    for (const s of body.split(/[,;|•·]/)) {
      const t = s.replace(/^[\s\-*]+|[\s.]+$/g, '')
      if (t && t.length <= 40 && t.split(' ').length <= 4) out.add(t)
    }
  }
  return [...out]
}

export function parseContact(text: string): { basics: Partial<Basics>; links: Partial<Links> } {
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? ''
  const phone = text.match(/(\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0]?.trim() ?? ''
  const url = (re: RegExp) => {
    const m = text.match(re)?.[0]
    return m ? (m.startsWith('http') ? m : `https://${m}`) : ''
  }
  const linkedin = url(/(https?:\/\/)?(www\.)?linkedin\.com\/in\/[\w\-%]+\/?/i)
  const github = url(/(https?:\/\/)?(www\.)?github\.com\/[\w-]+\/?/i)
  const anyUrl = [...text.matchAll(/(?<![@\w.-])(https?:\/\/)?(www\.)?[\w-]+\.(dev|io|me|com|site|app|xyz|net|org)(\/[\w\-./]*)?/gi)]
    .map((m) => m[0])
    .find((u) => !/linkedin|github|gmail|outlook|yahoo|hotmail|icloud/i.test(u) && !u.includes('@'))
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l && !l.includes('@') && !/\d{3}/.test(l)) ?? ''
  const nameParts = /^[A-Za-z'’.-]+(\s+[A-Za-z'’.-]+){1,3}$/.test(firstLine) ? firstLine.split(/\s+/) : []
  const loc = text.match(/\b([A-Z][a-zA-Z.]+(?: [A-Z][a-zA-Z.]+)*), ([A-Z]{2})\b/)
  return {
    basics: {
      firstName: nameParts[0] ?? '',
      lastName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : '',
      email,
      phone,
      city: loc?.[1] ?? '',
      state: loc?.[2] ?? '',
    },
    links: { linkedin, github, portfolio: anyUrl ? (anyUrl.startsWith('http') ? anyUrl : `https://${anyUrl}`) : '' },
  }
}

export function parseResume(text: string): ParsedResume {
  const s = splitSections(text)
  const contact = parseContact([...s.header, ...s.summary.slice(0, 2)].join('\n') || text.slice(0, 600))
  return {
    basics: { ...contact.basics, summary: s.summary.join(' ').slice(0, 1200) },
    links: contact.links,
    work: parseWork(s.experience),
    education: parseEducation(s.education),
    skills: parseSkills(s.skills),
  }
}

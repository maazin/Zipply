// Cheap check, run on every page: does this look like a job application?
// Only when it does does Zipply read the form, show the toolbar dot and watch
// for the confirmation page. The panel can always scan a page on request.
import { ADAPTERS } from './adapters'

const CONTROLS = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=search]), textarea, select'
const APPLY_WORDS = /\b(apply|application|applicant|candidate|career|careers|job|jobs|position|opening|vacanc|hiring|recruit)/i
const FIELD_WORDS = /\b(resume|résumé|cv|cover letter|linkedin|portfolio|work authori[sz]ation|sponsorship|years of experience|desired salary)\b/i
const NAME_WORDS = /\b(first name|last name|full name|given name|surname|legal name)\b|first_?name|last_?name|full_?name/i

export interface Detection {
  isApplication: boolean
  score: number
  fields: number
}

function attrText(el: Element): string {
  return [el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('autocomplete')]
    .filter(Boolean)
    .join(' ')
}

function labelText(doc: Document): string {
  return Array.from(doc.querySelectorAll('label, legend, [class*="label" i]'))
    .slice(0, 200)
    .map((l) => l.textContent ?? '')
    .join(' ')
    .slice(0, 20000)
}

export function detectApplication(doc: Document = document, url: URL = new URL(location.href)): Detection {
  if (ADAPTERS.some((a) => a.hosts?.test(url.hostname))) return { isApplication: true, score: 99, fields: doc.querySelectorAll(CONTROLS).length }

  const controls = Array.from(doc.querySelectorAll(CONTROLS))
  const fields = controls.length
  if (fields < 3) return { isApplication: false, score: 0, fields }

  const attrs = controls.slice(0, 300).map(attrText).join(' ')
  const labels = labelText(doc)
  const fieldText = `${attrs} ${labels}`
  const pageText = [
    url.pathname,
    doc.title,
    ...Array.from(doc.querySelectorAll('h1, h2, h3, button, [type=submit]'))
      .slice(0, 60)
      .map((n) => (n.textContent ?? '') + ' ' + ((n as HTMLInputElement).value ?? '')),
  ].join(' ')

  let score = 0
  const fileInputs = controls.filter((c) => (c as HTMLInputElement).type === 'file')
  if (fileInputs.some((f) => /resume|résumé|cv/i.test(attrText(f) + ' ' + (f.closest('label, div')?.textContent ?? '')))) score += 3
  else if (fileInputs.length) score += 1
  if (FIELD_WORDS.test(fieldText)) score += 2
  if (APPLY_WORDS.test(pageText)) score += 1
  if (APPLY_WORDS.test(url.hostname)) score += 1
  if (controls.some((c) => (c as HTMLInputElement).type === 'email') || /\be-?mail\b/i.test(fieldText)) score += 1
  if (NAME_WORDS.test(fieldText)) score += 1

  // A password box means sign-in or sign-up, unless there's a resume upload too.
  if (controls.some((c) => (c as HTMLInputElement).type === 'password') && score < 5) score = Math.min(score, 1)

  return { isApplication: score >= 4, score, fields }
}

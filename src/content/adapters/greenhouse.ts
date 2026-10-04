import type { Adapter } from './types'
import { genericConfirmation, mapBy } from './types'
import { textAt } from '../posting'

export const greenhouse: Adapter = {
  name: 'Greenhouse',
  hosts: /(^|\.)greenhouse\.io$/,
  detect: (url, doc) =>
    /(^|\.)greenhouse\.io$/.test(url.hostname) ||
    Boolean(doc.querySelector('#application_form, #grnhse_app, script[src*="boards.greenhouse.io/embed"]')),

  explicit: (fields) =>
    mapBy(
      fields,
      [
        [/^first_name$/, 'firstName'],
        [/^last_name$/, 'lastName'],
        [/^preferred_name$/, 'preferredName'],
        [/^email$/, 'email'],
        [/^phone$/, 'phone'],
        [/^(resume|resume_text)$/, 'resume'],
        [/^cover_letter$/, 'coverLetter'],
        [/^(candidate-location|job_application_location|location)$/, 'location'],
        [/^country$/, 'country'],
        [/^(gender|job_application\[gender\])$/, 'gender'],
        [/^(hispanic_ethnicity|job_application\[hispanic_ethnicity\])$/, 'hispanic'],
        [/^(race|job_application\[race\])$/, 'race'],
        [/^(veteran_status|job_application\[veteran_status\])$/, 'veteran'],
        [/^(disability_status|job_application\[disability_status\])$/, 'disability'],
      ],
      (c) => c.el.id || c.desc.name.replace(/^job_application\[(\w+)\]$/, '$1'),
    ),

  posting: (doc, url) => {
    // {boards,job-boards}.greenhouse.io/{company}/jobs/{id}, or /embed/job_app?for={company}&token={id}
    const m = url.pathname.match(/^\/([\w-]+)\/jobs\/(\d+)/)
    const tokenFromQuery = url.searchParams.get('for') ?? ''
    const company =
      doc.querySelector('.company-name')?.textContent?.replace(/^\s*at\s+/i, '').trim() ||
      doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ||
      (m?.[1] ?? tokenFromQuery).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    return {
      title: doc.querySelector('.app-title, h1.section-header, .job__title h1, h1')?.textContent?.trim() ?? '',
      company,
      location: doc.querySelector('.location, .job__location')?.textContent?.trim() ?? '',
      description: textAt(doc, ['#content', '.job__description', '.job-post-content', '[class*="job-description" i]']),
      jobId: m?.[2] ?? url.searchParams.get('token') ?? url.searchParams.get('gh_jid') ?? '',
    }
  },

  isConfirmation: (doc, url) =>
    /\/confirmation\b/.test(url.pathname) || Boolean(doc.querySelector('#application_confirmation, .application-confirmation')) || genericConfirmation(doc),
}

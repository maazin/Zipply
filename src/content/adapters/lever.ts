import type { Adapter } from './types'
import { genericConfirmation, mapBy } from './types'
import { fetchPosting, textAt } from '../posting'

export const lever: Adapter = {
  name: 'Lever',
  hosts: /(^|\.)lever\.co$/,
  detect: (url) => url.hostname === 'jobs.lever.co' || url.hostname.endsWith('.lever.co'),

  explicit: (fields) =>
    mapBy(
      fields,
      [
        [/^name$/, 'fullName'],
        [/^email$/, 'email'],
        [/^phone$/, 'phone'],
        [/^org$/, 'currentCompany'],
        [/^location$/, 'location'],
        [/^resume$/, 'resume'],
        [/^urls\[linkedin\]$/i, 'linkedin'],
        [/^urls\[github\]$/i, 'github'],
        [/^urls\[portfolio\]$/i, 'portfolio'],
        [/^urls\[other\]$/i, 'otherLink'],
        [/^eeo\[gender\]$/, 'gender'],
        [/^eeo\[race\]$/, 'race'],
        [/^eeo\[veteran\]$/, 'veteran'],
        [/^eeo\[disability\]$/, 'disability'],
      ],
      (c) => c.desc.name,
    ),

  async posting(doc, url) {
    // jobs.lever.co/{company}/{uuid}[/apply]
    const [, company = '', id = ''] = url.pathname.split('/')
    const title = doc.querySelector('.posting-headline h2, .posting-header h2, h2')?.textContent?.trim() ?? ''
    const location = doc.querySelector('.posting-categories .location, .sort-by-location, .posting-category.location')?.textContent?.trim() ?? ''
    let description = textAt(doc, ['.posting-page .content', '[data-qa="job-description"]', '.section-wrapper.page-full-width'])
    // The /apply page has no description; read it from the posting page.
    if (!description && /\/apply\/?$/.test(url.pathname)) {
      const page = await fetchPosting(url.href.replace(/\/apply\/?$/, ''))
      if (page) description = page.ld?.description || textAt(page.doc, ['[data-qa="job-description"]', '.section-wrapper.page-full-width', '.content'])
    }
    const logoAlt = doc.querySelector('.main-header-logo img')?.getAttribute('alt')?.replace(/\s*logo$/i, '') ?? ''
    return {
      title,
      company: logoAlt || company.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      location,
      description,
      jobId: id,
      employmentType: doc.querySelector('.posting-categories .commitment')?.textContent?.trim() ?? '',
    }
  },

  isConfirmation: (doc, url) => /\/thanks\/?$/.test(url.pathname) || Boolean(doc.querySelector('.application-confirmation, [data-qa="msg-submit-success"]')) || genericConfirmation(doc),
}

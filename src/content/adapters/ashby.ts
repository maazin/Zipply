import type { Adapter } from './types'
import { genericConfirmation, mapBy } from './types'
import { fetchPosting, textAt } from '../posting'

export const ashby: Adapter = {
  name: 'Ashby',
  hosts: /^jobs\.ashbyhq\.com$/,
  detect: (url) => url.hostname === 'jobs.ashbyhq.com',

  explicit: (fields) =>
    mapBy(
      fields,
      [
        [/^_systemfield_name$/, 'fullName'],
        [/^_systemfield_email$/, 'email'],
        [/^_systemfield_phone/, 'phone'],
        [/^_systemfield_resume$/, 'resume'],
        [/^_systemfield_location$/, 'location'],
        [/^_systemfield_linkedin/, 'linkedin'],
        [/^_systemfield_github/, 'github'],
        [/^_systemfield_(website|portfolio)/, 'portfolio'],
      ],
      (c) => c.el.id || c.desc.name,
    ),

  async posting(doc, url) {
    // jobs.ashbyhq.com/{company}/{uuid}[/application]
    const [, company = '', id = ''] = url.pathname.split('/')
    let description = textAt(doc, ['[class*="_descriptionText" i]', '[class*="description" i]'])
    if (!description && /\/application\/?$/.test(url.pathname)) {
      const page = await fetchPosting(url.href.replace(/\/application\/?$/, ''))
      description = page?.ld?.description ?? ''
    }
    return {
      title: doc.querySelector('h1, [class*="_title" i]')?.textContent?.trim() ?? '',
      company: company.replace(/[-_]/g, ' ').replace(/%20/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      description,
      jobId: id,
    }
  },

  isConfirmation: (doc) => Boolean(doc.querySelector('[class*="_success" i], [class*="confirmation" i]')) || genericConfirmation(doc),
}

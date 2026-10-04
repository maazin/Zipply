import type { Adapter } from './types'
import { genericConfirmation, mapBy } from './types'
import { textAt } from '../posting'

// iCIMS field names vary by company, but the PersonProfileFields / rcf names and
// the Address* ids are common. The form often lives in an iframe; the content
// script runs in every frame on icims.com.
export const icims: Adapter = {
  name: 'iCIMS',
  hosts: /(^|\.)icims\.com$/,
  detect: (url, doc) => /(^|\.)icims\.com$/.test(url.hostname) || Boolean(doc.querySelector('iframe[src*="icims.com"], #icims_content_iframe')),

  explicit: (fields) =>
    mapBy(
      fields,
      [
        [/FirstName$/i, 'firstName'],
        [/LastName$/i, 'lastName'],
        [/(^|\.)(Email|EmailAddress)$/i, 'email'],
        [/(PhoneNumber|HomePhone|MobilePhone|Phone)$/i, 'phone'],
        [/(AddressStreet1|Address1|Street1)$/i, 'addressLine1'],
        [/(AddressCity|\.City)$/i, 'city'],
        [/(AddressState|\.State)$/i, 'state'],
        [/(AddressZip|PostalCode|ZipCode)$/i, 'postalCode'],
        [/(AddressCountry|\.Country)$/i, 'country'],
        [/LinkedIn/i, 'linkedin'],
      ],
      (c) => c.desc.name || c.el.id,
    ),

  posting: (doc, url) => {
    const id = url.pathname.match(/\/jobs\/(\d+)/)?.[1] ?? ''
    const host = url.hostname.split('.')[0].replace(/^(careers|jobs)-?/, '')
    return {
      title: doc.querySelector('.iCIMS_Header, h1.iCIMS_Header, .iCIMS_JobHeaderTitle, h1')?.textContent?.trim() ?? '',
      company: doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || host.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      location: doc.querySelector('.iCIMS_JobHeaderData .header.left span, [class*="location" i]')?.textContent?.trim() ?? '',
      description: textAt(doc, ['.iCIMS_JobContent', '.iCIMS_InfoMsg_Job', '.iCIMS_Expandable_Text']),
      jobId: id,
    }
  },

  isConfirmation: (doc) => Boolean(doc.querySelector('.iCIMS_ThankYou, #iCIMS_ThankYouMessage')) || genericConfirmation(doc),
}

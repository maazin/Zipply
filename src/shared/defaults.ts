import type { Profile, Settings } from './types'

export const DECLINE = 'Decline to answer'

export function emptyProfile(): Profile {
  return {
    basics: {
      firstName: '',
      lastName: '',
      preferredName: '',
      pronouns: '',
      email: '',
      phone: '',
      addressLine1: '',
      city: '',
      state: '',
      postalCode: '',
      country: 'United States',
      headline: '',
      summary: '',
    },
    links: { linkedin: '', github: '', portfolio: '', other: '' },
    work: [],
    education: [],
    skills: [],
    answers: {
      workAuthorized: '',
      needsSponsorship: '',
      willingToRelocate: '',
      hasSecurityClearance: '',
      startDate: '',
      salaryExpectation: '',
      minSalary: null,
      yearsExperience: null,
      howDidYouHear: '',
      gender: DECLINE,
      race: DECLINE,
      hispanic: DECLINE,
      veteran: DECLINE,
      disability: DECLINE,
      employmentTypes: ['full-time'],
      workModes: ['remote', 'hybrid', 'onsite'],
      locations: [],
    },
    writingSamples: [],
    filters: {
      blockedCompanies: [],
      companyBadWords: ['staffing agency', 'recruiting agency'],
      companyGoodWords: [],
      jobBadWords: ['10+ years', 'unpaid'],
      applyAt: 70,
      maybeAt: 50,
    },
    updatedAt: 0,
  }
}

/**
 * Free Gemini models. The "-latest" aliases track Google's newest free Flash
 * models, so most upgrades need no change; pin an exact ID here if you prefer.
 */
export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  fillThreshold: 0.75,
  autoDraft: true,
  models: { flash: 'gemini-flash-latest', flashLite: 'gemini-flash-lite-latest' },
  dailyLimits: { flash: 250, flashLite: 1000 },
  cloudEmailFallback: false,
  sheetId: '',
  sheetUrl: '',
  googleEmail: '',
  gmailEnabled: false,
  lastGmailSync: 0,
  encrypted: false,
}

export function uid(len = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('')
}

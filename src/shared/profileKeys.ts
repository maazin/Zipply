import type { FieldKind, Profile } from './types'

/**
 * The fixed list of profile keys a form field can map to. The AI field mapper is
 * only allowed to answer with one of these names (or "none"), so a posting can't
 * steer what gets filled.
 */
export const PROFILE_KEYS = [
  'firstName',
  'lastName',
  'fullName',
  'preferredName',
  'pronouns',
  'email',
  'phone',
  'addressLine1',
  'city',
  'state',
  'postalCode',
  'country',
  'location',
  'linkedin',
  'github',
  'portfolio',
  'otherLink',
  'currentCompany',
  'currentTitle',
  'yearsExperience',
  'school',
  'degree',
  'major',
  'gradYear',
  'gpa',
  'workAuthorized',
  'needsSponsorship',
  'willingToRelocate',
  'hasSecurityClearance',
  'startDate',
  'salaryExpectation',
  'gender',
  'race',
  'hispanic',
  'veteran',
  'disability',
  'howDidYouHear',
  'summary',
  'resume',
  'coverLetter',
] as const

export type ProfileKey = (typeof PROFILE_KEYS)[number]

export interface KeyDef {
  key: ProfileKey
  label: string
  aliases: string[]
  autocomplete?: string[]
  /** Never guessed: left empty and flagged when not set. */
  sensitive?: boolean
  /** Field kinds this key can fill. Omitted means any non-file kind. */
  kinds?: FieldKind[]
  /** Yes/No style answer. */
  boolean?: boolean
}

const TEXTY: FieldKind[] = ['text', 'email', 'tel', 'url', 'number', 'textarea', 'select', 'combobox', 'radio', 'date']
const CHOICE: FieldKind[] = ['select', 'combobox', 'radio', 'checkbox', 'text', 'checkbox-group']

export const KEY_DEFS: KeyDef[] = [
  { key: 'firstName', label: 'First name', aliases: ['first name', 'given name', 'forename', 'legal first name', 'first'], autocomplete: ['given-name'] },
  { key: 'lastName', label: 'Last name', aliases: ['last name', 'surname', 'family name', 'legal last name', 'last'], autocomplete: ['family-name'] },
  { key: 'fullName', label: 'Full name', aliases: ['full name', 'name', 'your name', 'legal name', 'candidate name', 'full legal name'], autocomplete: ['name'] },
  { key: 'preferredName', label: 'Preferred name', aliases: ['preferred name', 'preferred first name', 'nickname', 'goes by', 'name you go by'], autocomplete: ['nickname'] },
  { key: 'pronouns', label: 'Pronouns', aliases: ['pronouns', 'preferred pronouns'] },
  { key: 'email', label: 'Email', aliases: ['email', 'email address', 'e mail'], autocomplete: ['email'], kinds: ['email', 'text'] },
  { key: 'phone', label: 'Phone', aliases: ['phone', 'phone number', 'mobile', 'mobile phone', 'mobile number', 'cell', 'cell phone', 'telephone', 'contact number'], autocomplete: ['tel', 'tel-national'], kinds: ['tel', 'text', 'number'] },
  { key: 'addressLine1', label: 'Address', aliases: ['address', 'street address', 'address line 1', 'street', 'home address', 'mailing address'], autocomplete: ['address-line1', 'street-address'] },
  { key: 'city', label: 'City', aliases: ['city', 'town', 'city town'], autocomplete: ['address-level2'] },
  { key: 'state', label: 'State', aliases: ['state', 'province', 'state province', 'state region', 'region'], autocomplete: ['address-level1'] },
  { key: 'postalCode', label: 'Postal code', aliases: ['zip', 'zip code', 'postal code', 'postcode', 'zip postal code'], autocomplete: ['postal-code'] },
  { key: 'country', label: 'Country', aliases: ['country', 'country region', 'country of residence'], autocomplete: ['country', 'country-name'] },
  { key: 'location', label: 'Location', aliases: ['location', 'current location', 'where are you located', 'city and state', 'location city', 'where do you live', 'based'] },
  { key: 'linkedin', label: 'LinkedIn', aliases: ['linkedin', 'linkedin profile', 'linkedin url', 'linkedin profile url'], kinds: ['url', 'text'] },
  { key: 'github', label: 'GitHub', aliases: ['github', 'github url', 'github profile'], kinds: ['url', 'text'] },
  { key: 'portfolio', label: 'Portfolio', aliases: ['portfolio', 'portfolio url', 'website', 'personal website', 'personal site', 'website url', 'blog'], autocomplete: ['url'], kinds: ['url', 'text'] },
  { key: 'otherLink', label: 'Other link', aliases: ['other website', 'other link', 'other url', 'additional link'], kinds: ['url', 'text'] },
  { key: 'currentCompany', label: 'Current company', aliases: ['current company', 'current employer', 'employer', 'company name', 'most recent employer', 'organization'], autocomplete: ['organization'] },
  { key: 'currentTitle', label: 'Current title', aliases: ['current title', 'current job title', 'job title', 'current role', 'current position', 'most recent title', 'title'], autocomplete: ['organization-title'] },
  { key: 'yearsExperience', label: 'Years of experience', aliases: ['years of experience', 'total years of experience', 'years experience', 'years of professional experience', 'how many years of experience'], kinds: ['text', 'number', 'select', 'combobox', 'radio'] },
  { key: 'school', label: 'School', aliases: ['school', 'university', 'college', 'institution', 'school name', 'school or university'] },
  { key: 'degree', label: 'Degree', aliases: ['degree', 'highest degree', 'degree type', 'level of education', 'education level', 'highest level of education'] },
  { key: 'major', label: 'Major', aliases: ['major', 'field of study', 'discipline', 'area of study', 'concentration'] },
  { key: 'gradYear', label: 'Graduation year', aliases: ['graduation year', 'graduation date', 'year of graduation', 'expected graduation', 'expected graduation date', 'end year'] },
  { key: 'gpa', label: 'GPA', aliases: ['gpa', 'grade point average', 'cumulative gpa'] },
  {
    key: 'workAuthorized',
    label: 'Work authorization',
    aliases: ['authorized to work', 'legally authorized', 'legally authorized to work', 'work authorization', 'eligible to work', 'right to work', 'employment eligibility', 'authorised to work'],
    sensitive: true,
    boolean: true,
    kinds: CHOICE,
  },
  {
    key: 'needsSponsorship',
    label: 'Needs sponsorship',
    aliases: ['sponsorship', 'require sponsorship', 'visa sponsorship', 'need sponsorship', 'immigration sponsorship', 'require visa', 'sponsorship for employment visa', 'h 1b'],
    sensitive: true,
    boolean: true,
    kinds: CHOICE,
  },
  { key: 'willingToRelocate', label: 'Willing to relocate', aliases: ['relocate', 'willing to relocate', 'relocation', 'open to relocation', 'open to relocating'], boolean: true, kinds: CHOICE },
  { key: 'hasSecurityClearance', label: 'Security clearance', aliases: ['security clearance', 'active clearance', 'active security clearance', 'clearance'], sensitive: true, boolean: true, kinds: CHOICE },
  { key: 'startDate', label: 'Start date', aliases: ['start date', 'available start date', 'earliest start date', 'when can you start', 'availability', 'date available'], kinds: [...TEXTY] },
  { key: 'salaryExpectation', label: 'Salary expectation', aliases: ['salary', 'desired salary', 'salary expectation', 'salary expectations', 'expected salary', 'expected compensation', 'compensation expectations', 'desired compensation', 'pay expectations'], sensitive: true },
  { key: 'gender', label: 'Gender', aliases: ['gender', 'gender identity', 'sex'], sensitive: true, kinds: CHOICE },
  { key: 'race', label: 'Race', aliases: ['race', 'ethnicity', 'race ethnicity', 'racial ethnic', 'race and ethnicity'], sensitive: true, kinds: CHOICE },
  { key: 'hispanic', label: 'Hispanic or Latino', aliases: ['hispanic', 'latino', 'hispanic latino', 'hispanic or latino'], sensitive: true, kinds: CHOICE },
  { key: 'veteran', label: 'Veteran status', aliases: ['veteran', 'protected veteran', 'veteran status', 'military status', 'military service'], sensitive: true, kinds: CHOICE },
  { key: 'disability', label: 'Disability', aliases: ['disability', 'disability status', 'have a disability'], sensitive: true, kinds: CHOICE },
  { key: 'howDidYouHear', label: 'How did you hear', aliases: ['how did you hear', 'how did you hear about us', 'source', 'referral source', 'where did you hear', 'how did you find', 'where did you find'] },
  { key: 'summary', label: 'Summary', aliases: ['summary', 'professional summary', 'headline', 'about you', 'bio'] },
  { key: 'resume', label: 'Resume', aliases: ['resume', 'cv', 'resume cv', 'upload resume', 'attach resume', 'resume upload'], kinds: ['file'] },
  { key: 'coverLetter', label: 'Cover letter', aliases: ['cover letter', 'coverletter', 'motivation letter'], kinds: ['file', 'textarea'] },
]

export const KEY_DEF: Record<ProfileKey, KeyDef> = Object.fromEntries(KEY_DEFS.map((d) => [d.key, d])) as Record<
  ProfileKey,
  KeyDef
>

export function isSensitive(key: string): boolean {
  return Boolean(KEY_DEF[key as ProfileKey]?.sensitive)
}

function yearsFromWork(p: Profile): number | null {
  if (p.answers.yearsExperience != null) return p.answers.yearsExperience
  let months = 0
  const now = new Date()
  for (const w of p.work) {
    if (!w.start) continue
    const [sy, sm] = w.start.split('-').map(Number)
    const end = w.current || !w.end ? [now.getFullYear(), now.getMonth() + 1] : w.end.split('-').map(Number)
    months += Math.max(0, (end[0] - sy) * 12 + ((end[1] || 1) - (sm || 1)))
  }
  return months ? Math.round((months / 12) * 10) / 10 : null
}

export function totalYears(p: Profile): number | null {
  return yearsFromWork(p)
}

/** The profile value for a key, as text. Empty string means "not set". */
export function valueFor(p: Profile, key: ProfileKey): string {
  const b = p.basics
  const a = p.answers
  const work = p.work[0]
  const edu = p.education[0]
  switch (key) {
    case 'firstName':
      return b.firstName
    case 'lastName':
      return b.lastName
    case 'fullName':
      return [b.firstName, b.lastName].filter(Boolean).join(' ')
    case 'preferredName':
      return b.preferredName || b.firstName
    case 'pronouns':
      return b.pronouns
    case 'email':
      return b.email
    case 'phone':
      return b.phone
    case 'addressLine1':
      return b.addressLine1
    case 'city':
      return b.city
    case 'state':
      return b.state
    case 'postalCode':
      return b.postalCode
    case 'country':
      return b.country
    case 'location':
      return [b.city, b.state].filter(Boolean).join(', ')
    case 'linkedin':
      return p.links.linkedin
    case 'github':
      return p.links.github
    case 'portfolio':
      return p.links.portfolio
    case 'otherLink':
      return p.links.other
    case 'currentCompany':
      return work?.company ?? ''
    case 'currentTitle':
      return work?.title ?? ''
    case 'yearsExperience': {
      const y = totalYears(p)
      return y == null ? '' : String(Math.floor(y))
    }
    case 'school':
      return edu?.school ?? ''
    case 'degree':
      return edu?.degree ?? ''
    case 'major':
      return edu?.major ?? ''
    case 'gradYear':
      return edu?.end ? edu.end.slice(0, 4) : ''
    case 'gpa':
      return edu?.gpa ?? ''
    case 'workAuthorized':
      return a.workAuthorized
    case 'needsSponsorship':
      return a.needsSponsorship
    case 'willingToRelocate':
      return a.willingToRelocate
    case 'hasSecurityClearance':
      return a.hasSecurityClearance
    case 'startDate':
      return a.startDate
    case 'salaryExpectation':
      return a.salaryExpectation
    case 'gender':
      return a.gender
    case 'race':
      return a.race
    case 'hispanic':
      return a.hispanic
    case 'veteran':
      return a.veteran
    case 'disability':
      return a.disability
    case 'howDidYouHear':
      return a.howDidYouHear
    case 'summary':
      return b.summary || b.headline
    case 'resume':
    case 'coverLetter':
      return ''
  }
}

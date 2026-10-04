import { emptyProfile } from '@/shared/defaults'
import type { FieldDescriptor, Posting, Profile } from '@/shared/types'

export function field(p: Partial<FieldDescriptor> & { zid: string }): FieldDescriptor {
  return {
    kind: 'text',
    label: '',
    name: '',
    idAttr: '',
    placeholder: '',
    ariaLabel: '',
    autocomplete: '',
    nearbyText: '',
    options: [],
    required: false,
    value: '',
    ...p,
  }
}

export function profile(): Profile {
  const p = emptyProfile()
  p.basics = {
    ...p.basics,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    phone: '(813) 555-0100',
    city: 'Tampa',
    state: 'FL',
    postalCode: '33602',
    addressLine1: '1 Main St',
    headline: 'Data analyst',
  }
  p.links = { linkedin: 'https://linkedin.com/in/ada', github: 'https://github.com/ada', portfolio: 'https://ada.dev', other: '' }
  p.work = [
    { id: 'w1', title: 'Data Analyst Intern', company: 'Acme Corp', location: 'Tampa, FL', start: '2025-05', end: '2025-08', current: false, description: '- Built dashboards in Tableau and SQL\n- Automated reports with Python and Pandas' },
  ]
  p.education = [{ id: 'e1', school: 'University of South Florida', degree: "Bachelor's", major: 'Computer Science', start: '2022-08', end: '2026-05', gpa: '3.7' }]
  p.skills = ['Python', 'SQL', 'Tableau', 'Pandas', 'Excel', 'Docker']
  p.answers = { ...p.answers, workAuthorized: 'Yes', needsSponsorship: 'No', yearsExperience: 1, minSalary: 65000, locations: ['Tampa, FL'] }
  return p
}

export function posting(p: Partial<Posting> = {}): Posting {
  return {
    title: 'Data Analyst I',
    company: 'Globex, Inc.',
    location: 'Tampa, FL',
    description: '',
    datePosted: '',
    salary: null,
    employmentType: 'FULL_TIME',
    jobId: 'R-100',
    url: 'https://globex.wd5.myworkdayjobs.com/en-US/careers/job/Tampa/Data-Analyst-I_R-100',
    workMode: '',
    ...p,
  }
}

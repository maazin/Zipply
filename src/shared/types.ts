// Shared data model. Everything personal lives in Profile and is stored encrypted.

export type YesNo = 'Yes' | 'No' | ''

export interface WorkEntry {
  id: string
  title: string
  company: string
  location: string
  /** YYYY-MM */
  start: string
  /** YYYY-MM, empty when current */
  end: string
  current: boolean
  description: string
}

export interface EducationEntry {
  id: string
  school: string
  degree: string
  major: string
  /** YYYY-MM */
  start: string
  /** YYYY-MM (graduation, or expected) */
  end: string
  gpa: string
}

export interface Basics {
  firstName: string
  lastName: string
  preferredName: string
  pronouns: string
  email: string
  phone: string
  addressLine1: string
  city: string
  state: string
  postalCode: string
  country: string
  headline: string
  summary: string
}

export interface Links {
  linkedin: string
  github: string
  portfolio: string
  other: string
}

export type EmploymentType = 'full-time' | 'part-time' | 'contract' | 'internship'
export type WorkMode = 'remote' | 'hybrid' | 'onsite'

export interface StandardAnswers {
  workAuthorized: YesNo
  needsSponsorship: YesNo
  willingToRelocate: YesNo
  hasSecurityClearance: YesNo
  startDate: string
  salaryExpectation: string
  /** Minimum annual base you'd accept, used by the Pay check. */
  minSalary: number | null
  yearsExperience: number | null
  howDidYouHear: string
  /** Voluntary EEO answers. Default "Decline to answer". */
  gender: string
  race: string
  hispanic: string
  veteran: string
  disability: string
  employmentTypes: EmploymentType[]
  workModes: WorkMode[]
  /** Cities or regions you'd work in, e.g. "Tampa, FL". */
  locations: string[]
}

export interface Filters {
  /** Companies you never want to apply to. */
  blockedCompanies: string[]
  /** Words in a company or job description that rule it out ("staffing agency"). */
  companyBadWords: string[]
  /** Words that override the bad words ("subsidiary of X"). */
  companyGoodWords: string[]
  /** Words in the job description that rule it out ("10+ years"). */
  jobBadWords: string[]
  /** Verdict thresholds (match score). */
  applyAt: number
  maybeAt: number
}

export interface Profile {
  basics: Basics
  links: Links
  work: WorkEntry[]
  education: EducationEntry[]
  skills: string[]
  answers: StandardAnswers
  writingSamples: string[]
  filters: Filters
  updatedAt: number
}

/** One text item from pdf.js, positioned in PDF user space (y grows upward). */
export interface TextItem {
  str: string
  x: number
  y: number
  w: number
  h: number
}

export interface PageLayout {
  width: number
  height: number
  items: TextItem[]
}

export interface ResumeMeta {
  id: string
  name: string
  tag: string
  mime: string
  size: number
  addedAt: number
  isDefault: boolean
}

/** Everything extracted from a resume file. Stored encrypted with the file. */
export interface ResumeContent {
  text: string
  /** Present for PDFs only. */
  pages?: PageLayout[]
  /** Header/footer text from DOCX (not visible to most ATS parsers). */
  headerFooterText?: string
}

export interface StoredResume extends ResumeMeta {
  content: ResumeContent
  /** Base64 file data. */
  data: string
}

export interface AnswerBankEntry {
  id: string
  label: string
  labelNorm: string
  answer: string
  fieldKind: FieldKind
  host: string
  source: 'typed' | 'ai'
  updatedAt: number
  uses: number
}

// ---------- Form fields ----------

export type FieldKind =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'textarea'
  | 'select'
  | 'combobox'
  | 'radio'
  | 'checkbox'
  | 'checkbox-group'
  | 'file'
  | 'date'

export interface FieldDescriptor {
  /** Stable id stamped on the element (data-zipply-id). */
  zid: string
  kind: FieldKind
  label: string
  name: string
  idAttr: string
  placeholder: string
  ariaLabel: string
  autocomplete: string
  nearbyText: string
  /** Visible option labels for select, radio, combobox, checkbox groups. */
  options: string[]
  required: boolean
  /** Current value (for reports). */
  value: string
  /** Adapter-provided section hint, e.g. "work-0". */
  section?: string
}

export type FieldStatus = 'filled' | 'low' | 'draft' | 'skipped'

export type FillSource = 'adapter' | 'rules' | 'bank' | 'ai-map' | 'ai-draft' | 'file' | 'none'

export interface FieldReport {
  zid: string
  label: string
  status: FieldStatus
  source: FillSource
  required: boolean
  /** True when required and still empty after filling. */
  missing: boolean
  key?: string
  confidence?: number
  reason?: string
  /** Grounding warnings for AI drafts. */
  warnings?: string[]
  frameId?: number
}

// ---------- Jobs ----------

export interface SalaryRange {
  min: number
  max: number
  currency: string
  period: 'year' | 'hour' | 'month' | 'unknown'
}

export interface Posting {
  title: string
  company: string
  location: string
  description: string
  /** ISO date when known. */
  datePosted: string
  salary: SalaryRange | null
  employmentType: string
  jobId: string
  url: string
  workMode: WorkMode | ''
}

export type AtsName = 'Workday' | 'iCIMS' | 'Greenhouse' | 'Lever' | 'Ashby' | 'Other'

export type AppStatus = 'Applied' | 'Received' | 'Assessment' | 'Interview' | 'Offer' | 'Rejected'

export interface JobRecord {
  appId: string
  dateApplied: string
  company: string
  title: string
  location: string
  jobId: string
  ats: AtsName
  url: string
  resumeUsed: string
  matchScore: number | ''
  verdict: Verdict | ''
  redFlags: string
  status: AppStatus
  firstReply: string
  lastStatusChange: string
  notes: string
}

/** Local cache of what's in the sheet, for instant already-applied lookups. */
export interface AppliedEntry {
  key: string
  appId: string
  company: string
  companyNorm: string
  title: string
  jobId: string
  url: string
  dateApplied: string
  status: AppStatus
  firstReply: string
  lastStatusChange: string
  /** 1-based sheet row, when known. */
  row?: number
}

// ---------- Checks ----------

export type Verdict = 'Apply' | 'Maybe' | 'Skip'
export type DimensionResult = 'pass' | 'warn' | 'fail' | 'n/a'

export interface MatchResult {
  resumeId: string
  score: number
  keywordMatch: number
  skillsCoverage: number
  sectionCompleteness: number
  matched: string[]
  /** Missing here but present in profile or another resume. */
  canAdd: string[]
  /** Missing everywhere. Shown, never stuffed in. */
  realGap: string[]
  tips: string[]
}

export interface VerdictResult {
  verdict: Verdict
  reason: string
  dimensions: { name: 'Role fit' | 'Level' | 'Logistics' | 'Pay'; result: DimensionResult; note: string }[]
  blockers: string[]
}

export type LegitimacyTier = 'High confidence' | 'Proceed with caution' | 'Suspicious'

export interface RedFlagResult {
  flags: string[]
  tier: LegitimacyTier
}

export interface AppliedCheck {
  alreadyApplied: AppliedEntry | null
  possiblyApplied: AppliedEntry | null
}

export type AtsGrade = 'Good' | 'Fix' | 'Broken'

export interface AtsCheck {
  name: 'Text layer' | 'Contact details' | 'Clean characters' | 'Reading order' | 'Sections' | 'Keyword coverage'
  pass: boolean | null
  reason: string
}

export interface AtsReport {
  grade: AtsGrade
  checks: AtsCheck[]
}

// ---------- Settings (not secret, stored in the clear) ----------

export interface Settings {
  onboarded: boolean
  fillThreshold: number
  autoDraft: boolean
  models: { flash: string; flashLite: string }
  dailyLimits: { flash: number; flashLite: number }
  /** Off by default: unclear emails never go to the cloud. */
  cloudEmailFallback: boolean
  sheetId: string
  sheetUrl: string
  googleEmail: string
  gmailEnabled: boolean
  lastGmailSync: number
  encrypted: boolean
}

export interface StatusEvent {
  id: string
  appId: string
  company: string
  title: string
  from: AppStatus
  to: AppStatus
  at: number
  seen: boolean
  kind: 'change' | 'offer' | 'conflict'
  note: string
}

export interface UnmatchedEmail {
  messageId: string
  reason: string
  candidates: string[]
  at: number
}

export interface QueueItem {
  id?: number
  op: 'append' | 'status'
  payload: unknown
  attempts: number
  lastError: string
  createdAt: number
}

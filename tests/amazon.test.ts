import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { amazon, amazonApplications, amazonJobId, amazonPosting, isAmazonApplications } from '@/content/adapters/amazon'
import { pickAdapter } from '@/content/adapters'
import { detectApplication } from '@/content/detect'

function load(name: string) {
  const doc = new DOMParser().parseFromString(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'), 'text/html')
  document.title = doc.title
  document.head.innerHTML = doc.head.innerHTML
  document.body.innerHTML = doc.body.innerHTML
}

const JOB = new URL('https://www.amazon.jobs/en/jobs/10386857/software-engineer')

describe('amazon.jobs', () => {
  it('reads a posting from its sections, without the sidebar or recommended jobs', () => {
    load('amazon-job.html')
    const p = amazonPosting(document, JOB)!
    expect(p).toMatchObject({ title: 'Software Engineer', company: 'Amazon', location: 'USA, WA, Seattle', jobId: '10386857' })
    expect(p.description).toContain('distributed services in Java and Python')
    expect(p.description).toContain('Basic Qualifications')
    expect(p.description).toContain('Kubernetes and Docker')
    expect(p.description).not.toContain('Salesforce team')
    expect(p.description).not.toContain('Software Development\n')
  })

  it('names a hiring entity that is not Amazon itself', () => {
    load('amazon-job.html')
    document.querySelector('.details-line .meta')!.textContent = 'Job ID: 10386857 | Zoox, Inc'
    expect(amazonPosting(document, JOB)!.company).toBe('Zoox, Inc')
  })

  it('claims postings and applications, not search pages, and does not make every page an application', () => {
    load('amazon-job.html')
    expect(pickAdapter(JOB, document).name).toBe('Amazon')
    expect(pickAdapter(new URL('https://www.amazon.jobs/applicant/jobs/10386857/apply'), document).name).toBe('Amazon')
    expect(pickAdapter(new URL('https://www.amazon.jobs/en/search?base_query=sde'), document).name).toBe('Other')
    expect(detectApplication(document, JOB).isApplication).toBe(false)
    expect(amazonJobId(new URL('https://www.amazon.jobs/applicant/jobs/10386857/apply'))).toBe('10386857')
  })

  it('is not a posting on other pages', () => {
    document.body.innerHTML = '<h1>Job search</h1><p>Results</p>'
    expect(amazonPosting(document, new URL('https://www.amazon.jobs/en/search'))).toBeNull()
  })

  it('reads your Applications page, and never takes it for a confirmation', () => {
    load('amazon-applications.html')
    const url = new URL('https://www.amazon.jobs/en-US/applicant')
    expect(isAmazonApplications(url)).toBe(true)
    expect(isAmazonApplications(new URL('https://www.amazon.jobs/applicant/dashboard'))).toBe(true)
    expect(isAmazonApplications(new URL('https://www.amazon.jobs/applicant/jobs/10386857/apply'))).toBe(false)
    const apps = amazonApplications(document)
    expect(apps.map((a) => [a.posting.title, a.posting.jobId, a.date])).toEqual([
      ['Software Development Engineer, Early Career - 2027 (US)', '10583340', '2026-11-24'],
      ['Software Development Engineer, ROBOTICS, Early Career - 2027', '10567489', '2026-11-20'],
      ['Data Engineer', '10100000', '2025-01-05'],
    ])
    expect(apps[0].posting).toMatchObject({ company: 'Amazon', location: 'US, WA, Seattle', url: 'https://www.amazon.jobs/en/jobs/10583340' })
    expect(amazon.isConfirmation(document, url)).toBe(false)
  })

  it('takes a thank-you page in the application for the confirmation', () => {
    document.body.innerHTML = '<h1>Thank you for applying!</h1><p>We received your application.</p>'
    expect(amazon.isConfirmation(document, new URL('https://www.amazon.jobs/applicant/jobs/10386857/apply/confirmation'))).toBe(true)
  })
})

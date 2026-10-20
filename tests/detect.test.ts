import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectApplication } from '@/content/detect'

function doc(html: string) {
  return new DOMParser().parseFromString(html, 'text/html')
}
const fixture = (n: string) => doc(readFileSync(join(import.meta.dirname, 'fixtures', n), 'utf8'))

describe('detectApplication on any site', () => {
  it('recognizes application forms on unknown hosts', () => {
    expect(detectApplication(fixture('custom.html'), new URL('https://careers.initech.com/jobs/42')).isApplication).toBe(true)
    expect(detectApplication(fixture('greenhouse.html'), new URL('https://www.globex.com/careers/apply?gh_jid=4012345')).isApplication).toBe(true)
    expect(detectApplication(fixture('lever.html'), new URL('https://globex.com/join-us')).isApplication).toBe(true)
  })

  it('always activates on ATS hosts', () => {
    expect(detectApplication(doc('<p>loading</p>'), new URL('https://acme.wd5.myworkdayjobs.com/x')).isApplication).toBe(true)
  })

  it('ignores ordinary forms', () => {
    const login = doc('<form><input type=email name=email><input type=password name=pw><input type=checkbox name=remember><button>Sign in</button></form>')
    const newsletter = doc('<form><input type=email placeholder="Email"><button>Subscribe</button></form>')
    const checkout = doc(`<h1>Checkout</h1><form><label>Full name <input name=name></label><label>Email <input type=email></label>
      <label>Address <input name=address></label><label>Card number <input name=cc></label><button>Pay now</button></form>`)
    const contact = doc('<h1>Contact us</h1><form><input name=name placeholder="Name"><input type=email><textarea name=message></textarea><button>Send</button></form>')
    const search = doc('<form><input type=text name=q><select><option>All</option></select><input type=text name=loc><button>Search</button></form>')
    for (const d of [login, newsletter, checkout, contact, search]) expect(detectApplication(d, new URL('https://example.com/')).isApplication).toBe(false)
  })

  it('does not trip on a job-board sign-in page', () => {
    const d = doc('<h1>Sign in to apply</h1><form><input type=email name=email><input type=password><input name=first_name><button>Sign in</button></form>')
    expect(detectApplication(d, new URL('https://jobs.example.com/login')).isApplication).toBe(false)
  })
})

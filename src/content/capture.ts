// Save the application form on this page as a test fixture: the page's
// structure and labels, with nothing you typed, no tokens and no scripts.

const TEXTLIKE = new Set(['', 'text', 'email', 'tel', 'url', 'number', 'date', 'month', 'search', 'password', 'hidden'])

/** Strip query strings and fragments, which often carry session or tracking tokens. */
function bareUrl(u: string): string {
  try {
    const url = new URL(u, 'https://example.invalid')
    return url.origin === 'https://example.invalid' ? url.pathname : `${url.origin}${url.pathname}`
  } catch {
    return ''
  }
}

/** A sanitized copy of the document as HTML. */
export function sanitizeForm(doc: Document, pageUrl: string): string {
  const root = doc.documentElement.cloneNode(true) as HTMLElement

  // Scripts, except the JobPosting data Zipply reads; other active or heavy content.
  root.querySelectorAll('script').forEach((s) => {
    if (s.getAttribute('type') !== 'application/ld+json') s.remove()
  })
  root.querySelectorAll('noscript, style, link, iframe, object, embed, video, audio, canvas, svg, img, picture, source').forEach((n) => n.remove())

  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || name === 'style' || name === 'srcset' || name.startsWith('data-zipply')) el.removeAttribute(attr.name)
      else if (name === 'href' || name === 'action' || name === 'src') el.setAttribute(attr.name, bareUrl(attr.value))
      else if (/token|csrf|nonce|session|auth/i.test(name)) el.removeAttribute(attr.name)
    }
    if (el instanceof HTMLInputElement) {
      if (TEXTLIKE.has((el.getAttribute('type') ?? '').toLowerCase())) el.removeAttribute('value')
      el.removeAttribute('checked')
    }
    if (el instanceof HTMLOptionElement) el.removeAttribute('selected')
    if (el instanceof HTMLTextAreaElement) el.textContent = ''
    if (el.getAttribute('contenteditable') === 'true') el.textContent = ''
  }

  const head = root.querySelector('head') ?? root.insertBefore(doc.createElement('head'), root.firstChild)
  const meta = doc.createElement('meta')
  meta.setAttribute('name', 'zipply-url')
  meta.setAttribute('content', bareUrl(pageUrl))
  head.prepend(meta)
  return `<!doctype html>\n<!-- Captured by Zipply for testing. Values, scripts and tokens removed. -->\n${root.outerHTML}`
}

/** Replace any of your own details that appear in the page text (e.g. a pre-filled greeting). */
export function scrubPersonal(html: string, values: string[]): string {
  let out = html
  const list = values.map((v) => v.trim()).filter((v) => v.length >= 3).sort((a, b) => b.length - a.length)
  for (const v of list) out = out.split(v).join('[redacted]')
  return out
}

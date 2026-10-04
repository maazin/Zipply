// Offscreen document: parses email HTML to text and runs Gemini Nano for the
// service worker, which has no DOM and may not expose the Prompt API.
import { nanoPrompt, nanoStatus } from '@/lib/nano'

export type OffscreenMsg =
  | { target: 'offscreen'; type: 'html2text'; html: string }
  | { target: 'offscreen'; type: 'nano'; system: string; prompt: string; schema?: object }
  | { target: 'offscreen'; type: 'nano-status' }

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style, head').forEach((n) => n.remove())
  doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'))
  doc.querySelectorAll('p, div, tr, li, h1, h2, h3, h4').forEach((n) => n.append('\n'))
  return (doc.body?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
}

chrome.runtime.onMessage.addListener((msg: OffscreenMsg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return false
  ;(async () => {
    if (msg.type === 'html2text') return { text: htmlToText(msg.html) }
    if (msg.type === 'nano-status') return { status: await nanoStatus() }
    if (msg.type === 'nano') return { text: await nanoPrompt(msg.system, msg.prompt, msg.schema) }
    return { error: 'unknown' }
  })()
    .then(reply)
    .catch((e) => reply({ error: e instanceof Error ? e.message : String(e) }))
  return true
})

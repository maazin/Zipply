// The Zipply tab: a small piece of the logo at the right edge of job pages.
// Clicking it opens the side panel, so you don't have to reach for the
// toolbar. Drag it up or down; its × hides it on that site (Settings brings it
// back). Only the top frame draws it; frames with a form ask the top one.
import { MARK_SVG } from '@/shared/logo'
import { send } from '@/shared/messages'

export type SideTabKind = 'job' | 'form'

const HIDDEN_KEY = 'sideTabHidden'
const TOP_KEY = 'sideTabTop'
const ASK = 'zipply:side-tab'

const CSS = `
:host { all: initial; position: fixed; right: 0; z-index: 2147483646; }
@media print { :host { display: none } }
.tab {
  position: relative; display: flex; align-items: center; box-sizing: border-box;
  width: 44px; height: 44px; padding-left: 6px; border: 0; margin: 0;
  border-radius: 14px 0 0 14px; cursor: pointer; touch-action: none;
  background: linear-gradient(135deg, #3D7BFF, #6A35F2);
  box-shadow: 0 4px 16px rgba(36, 30, 110, .32), 0 1px 3px rgba(0, 0, 0, .18);
  transform: translateX(8px); transition: transform .16s ease, box-shadow .16s ease;
}
.tab:hover, .tab:focus-visible, .tab.dragging { transform: translateX(0); box-shadow: 0 6px 22px rgba(36, 30, 110, .42), 0 1px 3px rgba(0, 0, 0, .2); }
.tab:focus-visible { outline: 2px solid #fff; outline-offset: -4px; }
.tab.dragging { cursor: grabbing; transition: none; }
.tab svg { width: 32px; height: 32px; display: block; pointer-events: none; }
.dot { position: absolute; bottom: 5px; left: 5px; width: 9px; height: 9px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 2px #fff; display: none; }
.form .dot { display: block; }
.close {
  position: absolute; top: -9px; left: -9px; width: 20px; height: 20px; padding: 0; border: 0;
  border-radius: 50%; background: #18181b; color: #fff; cursor: pointer;
  font: 600 13px/20px system-ui, -apple-system, sans-serif; text-align: center;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .3); opacity: 0; transition: opacity .12s;
}
:host(:hover) .close, .close:focus-visible { opacity: 1; }
.note {
  position: absolute; right: 52px; top: 50%; transform: translateY(-50%); width: max-content; max-width: 240px;
  padding: 7px 10px; border-radius: 8px; background: #18181b; color: #fff;
  font: 12.5px/1.4 system-ui, -apple-system, sans-serif; box-shadow: 0 4px 14px rgba(0, 0, 0, .25);
}
`

let host: HTMLElement | null = null
let kind: SideTabKind = 'job'

async function allowed(): Promise<boolean> {
  try {
    const got = await chrome.storage.local.get(['settings', HIDDEN_KEY])
    const on = (got.settings as { sideTab?: boolean } | undefined)?.sideTab !== false
    return on && !((got[HIDDEN_KEY] as string[] | undefined) ?? []).includes(location.hostname)
  } catch {
    return false
  }
}

function note(root: ShadowRoot, text: string, ms = 3500) {
  root.querySelector('.note')?.remove()
  const n = document.createElement('div')
  n.className = 'note'
  n.textContent = text
  root.append(n)
  setTimeout(() => n.remove(), ms)
}

function build(): HTMLElement {
  const el = document.createElement('zipply-tab')
  const root = el.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>${CSS}</style>
<div class="tab" role="button" tabindex="0" aria-label="Open Zipply" title="Open Zipply (Alt+Shift+F)"><span class="dot"></span>${MARK_SVG}</div>
<button class="close" aria-label="Hide the Zipply tab on this site" title="Hide on this site">×</button>`
  const tab = root.querySelector<HTMLElement>('.tab')!
  const close = root.querySelector<HTMLElement>('.close')!

  const place = (top: number) => (el.style.top = `${Math.round(Math.min(Math.max(top, 8), innerHeight - 52))}px`)
  place(innerHeight * 0.38)
  void chrome.storage.local.get(TOP_KEY).then((got) => {
    const frac = got[TOP_KEY] as number | undefined
    if (typeof frac === 'number') place(frac * innerHeight)
  }).catch(() => undefined)

  const open = () => {
    // Sent straight from the click, so Chrome lets the panel open.
    send<{ ok?: boolean; error?: string }>({ type: 'panel:open' })
      .then((r) => r?.error && note(root, 'Click the Zipply icon in the toolbar to open it.'))
      .catch(() => note(root, 'Zipply was just updated. Reload this page to use the tab.'))
  }

  // Drag to move; a press that doesn't move is a click.
  let start: { y: number; top: number } | null = null
  let moved = false
  tab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    start = { y: e.clientY, top: el.getBoundingClientRect().top }
    moved = false
    tab.setPointerCapture(e.pointerId)
  })
  tab.addEventListener('pointermove', (e) => {
    if (!start) return
    if (!moved && Math.abs(e.clientY - start.y) < 4) return
    moved = true
    tab.classList.add('dragging')
    place(start.top + e.clientY - start.y)
  })
  tab.addEventListener('pointerup', () => {
    if (!start) return
    start = null
    tab.classList.remove('dragging')
    if (moved) void chrome.storage.local.set({ [TOP_KEY]: el.getBoundingClientRect().top / innerHeight }).catch(() => undefined)
    else open()
  })
  tab.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open()
    }
  })
  close.addEventListener('click', async (e) => {
    e.stopPropagation()
    try {
      const got = await chrome.storage.local.get(HIDDEN_KEY)
      const hidden = new Set((got[HIDDEN_KEY] as string[] | undefined) ?? [])
      hidden.add(location.hostname)
      await chrome.storage.local.set({ [HIDDEN_KEY]: [...hidden] })
    } catch {
      // Zipply reloaded: just take it off this page.
    }
    tab.remove()
    close.remove()
    note(root, "Hidden on this site. Turn it back on in Zipply's settings.")
    setTimeout(removeSideTab, 3500)
  })
  return el
}

function removeSideTab() {
  host?.remove()
  host = null
}

/** Show the tab (top frame), or ask the top frame to show it (a frame with a form). */
export async function showSideTab(next: SideTabKind) {
  if (window !== window.top) {
    window.top?.postMessage({ [ASK]: next }, '*')
    return
  }
  if (next === 'form') kind = 'form'
  if (!host && !(await allowed())) return
  if (!host) host = build()
  // Some sites replace the whole page; put it back if it was dropped.
  if (!host.isConnected) document.documentElement.append(host)
  host.shadowRoot!.querySelector('.tab')?.classList.toggle('form', kind === 'form')
}

/** In the top frame: listen for frames asking for the tab, and follow the setting. */
export function watchSideTab() {
  if (window !== window.top) return
  addEventListener('message', (e) => {
    const asked = (e.data as Record<string, unknown> | null)?.[ASK]
    if (asked === 'form' || asked === 'job') void showSideTab(asked)
  })
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !(changes.settings || changes[HIDDEN_KEY]) || !host) return
    if (!(await allowed())) removeSideTab()
  })
}

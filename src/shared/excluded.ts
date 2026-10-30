// Sites Zipply skips entirely: the manifest's exclude list, and the same rule
// for tabs Zipply puts itself back into after an update.
export const EXCLUDED = [
  'https://mail.google.com/*',
  'https://docs.google.com/*',
  'https://drive.google.com/*',
  'https://calendar.google.com/*',
  'https://meet.google.com/*',
  'https://*.youtube.com/*',
  'https://accounts.google.com/*',
]

const HOSTS = /^(mail|docs|drive|calendar|meet|accounts)\.google\.com$|(^|\.)youtube\.com$/

export function isExcluded(url: string): boolean {
  try {
    const u = new URL(url)
    return !/^https?:$/.test(u.protocol) || HOSTS.test(u.hostname)
  } catch {
    return true
  }
}

/** Sites the side panel leaves alone: the excluded ones, except Google Forms, which it fills on request. */
export function panelSkips(url: string): boolean {
  return isExcluded(url) && !/^https:\/\/docs\.google\.com\/forms\//.test(url)
}

// Google auth via chrome.identity. Tokens are managed by Chrome and never
// written to storage by the extension.

export const SCOPES = {
  drive: 'https://www.googleapis.com/auth/drive.file',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  email: 'https://www.googleapis.com/auth/userinfo.email',
}

export class NotConnectedError extends Error {
  constructor(msg = 'Connect Google on the Profile page first.') {
    super(msg)
    this.name = 'NotConnectedError'
  }
}

export async function getToken(interactive: boolean, scopes: string[]): Promise<string> {
  try {
    const res = await chrome.identity.getAuthToken({ interactive, scopes })
    const token = typeof res === 'string' ? res : res?.token
    if (!token) throw new NotConnectedError()
    return token
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/not signed in|did not approve|user interaction required|OAuth2 not granted|canceled/i.test(msg)) throw new NotConnectedError()
    if (/bad client id|invalid_client/i.test(msg))
      throw new Error('The Google OAuth client ID is missing or wrong. See README > Setup > Google sign-in.')
    throw e
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** fetch with a Google token; retries once with a fresh token on 401. */
export async function gfetch<T>(url: string, scopes: string[], init: RequestInit = {}, interactive = false): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(interactive, scopes)
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
    if (res.status === 401 && attempt === 0) {
      await chrome.identity.removeCachedAuthToken({ token })
      continue
    }
    if (!res.ok) {
      let detail = ''
      try {
        detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? ''
      } catch {
        /* not JSON */
      }
      throw new HttpError(res.status, `Google API ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
  }
  throw new NotConnectedError()
}

export async function signOut(): Promise<void> {
  try {
    const token = await getToken(false, [SCOPES.drive])
    await chrome.identity.removeCachedAuthToken({ token })
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' })
  } catch {
    /* already signed out */
  }
  await chrome.identity.clearAllCachedAuthTokens()
}

export async function userEmail(): Promise<string> {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: chrome.identity.AccountStatus.ANY })
    return info.email
  } catch {
    return ''
  }
}

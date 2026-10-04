import { defineManifest } from '@crxjs/vite-plugin'
import { loadEnv } from 'vite'
import pkg from './package.json'

// Hosts with a dedicated adapter. Content scripts run here automatically; on any
// other site they are injected only when you open the panel (activeTab).
export const ATS_MATCHES = [
  'https://*.myworkdayjobs.com/*',
  'https://*.myworkday.com/*',
  'https://*.icims.com/*',
  'https://boards.greenhouse.io/*',
  'https://job-boards.greenhouse.io/*',
  'https://jobs.lever.co/*',
  'https://jobs.ashbyhq.com/*',
]

// Network lock: extension pages and the service worker may only reach Google's
// OAuth, Sheets, Gmail and Gemini endpoints.
const CONNECT_SRC = [
  "'self'",
  'https://oauth2.googleapis.com',
  'https://www.googleapis.com',
  'https://sheets.googleapis.com',
  'https://gmail.googleapis.com',
  'https://generativelanguage.googleapis.com',
].join(' ')

export default defineManifest((env) => {
  const vars = { ...loadEnv(env.mode, process.cwd(), 'VITE_'), ...process.env }
  const clientId = vars.VITE_GOOGLE_CLIENT_ID || 'SET_VITE_GOOGLE_CLIENT_ID.apps.googleusercontent.com'
  const key = vars.VITE_EXTENSION_KEY
  const isDev = env.mode === 'development'

  return {
    manifest_version: 3,
    name: 'Zipply',
    short_name: 'Zipply',
    description: 'Zip through job applications: one profile, one click, and a tracker that keeps itself current.',
    version: pkg.version,
    ...(key ? { key } : {}),
    icons: {
      16: 'public/icons/icon-16.png',
      32: 'public/icons/icon-32.png',
      48: 'public/icons/icon-48.png',
      128: 'public/icons/icon-128.png',
    },
    action: {
      default_title: 'Zipply (Alt+Shift+F)',
      default_icon: {
        16: 'public/icons/icon-16.png',
        32: 'public/icons/icon-32.png',
      },
    },
    background: {
      service_worker: 'src/background/index.ts',
      type: 'module',
    },
    side_panel: {
      default_path: 'src/sidepanel/index.html',
    },
    options_page: 'src/options/index.html',
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+F' },
        description: 'Open the Zipply panel',
      },
    },
    content_scripts: [
      {
        matches: ATS_MATCHES,
        js: ['src/content/index.ts'],
        run_at: 'document_idle',
        all_frames: true,
      },
    ],
    permissions: [
      'storage',
      'unlimitedStorage',
      'sidePanel',
      'activeTab',
      'scripting',
      'alarms',
      'identity',
      'contextMenus',
      'offscreen',
      'identity.email',
    ],
    host_permissions: ATS_MATCHES,
    optional_host_permissions: ['https://*/*'],
    oauth2: {
      client_id: clientId,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    },
    // The dev server needs a websocket and localhost scripts, so the lock only
    // applies to production builds.
    ...(isDev
      ? {}
      : {
          content_security_policy: {
            extension_pages: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src ${CONNECT_SRC};`,
          },
        }),
    web_accessible_resources: [],
  }
})

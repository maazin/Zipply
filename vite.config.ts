import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { crx } from '@crxjs/vite-plugin'
import { fileURLToPath } from 'node:url'
import manifest from './manifest.config'

// A new ID per build, compiled in and written to dist/build.json, so a running
// copy can tell when the files on disk are newer (see src/lib/selfUpdate.ts).
const BUILD = new Date().toISOString()

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    crx({ manifest }),
    {
      name: 'zipply-build-id',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ build: BUILD }) })
      },
    },
  ],
  define: { __BUILD__: JSON.stringify(BUILD) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'chrome120',
    sourcemap: false,
    rollupOptions: {
      input: {
        offscreen: 'src/offscreen/index.html',
      },
    },
  },
  server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
})

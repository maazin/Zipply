import { createRoot } from 'react-dom/client'
import '@/ui/styles.css'
import { App } from './App'
import { reloadIfBackgroundStale } from '@/lib/selfUpdate'

// A rebuilt Zipply whose background is still the old one reloads itself first.
void reloadIfBackgroundStale().then((reloading) => {
  if (!reloading) createRoot(document.getElementById('root')!).render(<App />)
})

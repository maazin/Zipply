import { useEffect, useState } from 'react'
import { deleteAll, exportAll, importAll, type ExportFile } from '@/lib/repo'
import { lock, removePassphrase, setPassphrase, usesPassphrase } from '@/lib/keys'
import { Button, Field, Input } from '@/ui/kit'
import { Section } from '../App'

export function Privacy({ onChanged }: { onChanged: () => void }) {
  const [hasPass, setHasPass] = useState(false)
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [msg, setMsg] = useState('')
  const [sure, setSure] = useState(false)

  useEffect(() => {
    usesPassphrase().then(setHasPass)
  }, [])

  async function savePass() {
    setMsg('')
    if (pass !== confirm) return setMsg("Those don't match.")
    try {
      await setPassphrase(pass)
      setHasPass(true)
      setPass('')
      setConfirm('')
      setMsg('Passphrase set. You enter it once per browser session.')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }

  async function doExport() {
    const data = await exportAll()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `zipply-profile-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function doImport(file: File) {
    setMsg('')
    try {
      await importAll(JSON.parse(await file.text()) as ExportFile)
      setMsg('Imported.')
      onChanged()
      window.dispatchEvent(new Event('zipply:resumes'))
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Section id="privacy" title="Privacy and data" intro="Your profile, resumes and answer bank are encrypted in this browser (AES-GCM). There's no Zipply server.">
      <div className="flex flex-col gap-6">
        <div>
          <h3 className="text-sm font-semibold">Passphrase</h3>
          <p className="mt-1 text-xs text-muted">
            {hasPass
              ? 'Your data is encrypted with a key derived from your passphrase. It is forgotten when the browser closes.'
              : 'Without a passphrase, data is encrypted with a key stored on this device. Set one so nobody with access to this browser profile can read it.'}
          </p>
          <div className="mt-3 grid max-w-lg gap-3 sm:grid-cols-2">
            <Field label={hasPass ? 'New passphrase' : 'Passphrase'}><Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></Field>
            <Field label="Confirm"><Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={savePass} disabled={pass.length < 8}>{hasPass ? 'Change passphrase' : 'Set passphrase'}</Button>
            {hasPass && <Button variant="ghost" onClick={async () => { await lock(); onChanged() }}>Lock now</Button>}
            {hasPass && <Button variant="ghost" onClick={async () => { await removePassphrase(); setHasPass(false); setMsg('Passphrase removed.') }}>Remove passphrase</Button>}
          </div>
          <p className="mt-2 text-xs text-muted">If you forget it, your data can't be recovered. Export a backup first.</p>
        </div>

        <div className="border-t border-line pt-6">
          <h3 className="text-sm font-semibold">Backup</h3>
          <p className="mt-1 text-xs text-muted">One readable JSON file with your profile, answer bank and resumes. Not encrypted, so keep it somewhere safe. Your Gemini key isn't included.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={doExport}>Export profile</Button>
            <label className="inline-flex cursor-pointer">
              <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
              <span className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3.5 text-sm font-medium hover:bg-sunken">Import profile</span>
            </label>
          </div>
        </div>

        <div className="border-t border-line pt-6">
          <h3 className="text-sm font-semibold text-bad">Delete everything</h3>
          <p className="mt-1 text-xs text-muted">Removes your profile, resumes, answer bank, keys, settings and local caches from this browser. Your Google Sheet stays in your Drive.</p>
          {!sure ? (
            <Button variant="danger" className="mt-3" onClick={() => setSure(true)}>Delete all data…</Button>
          ) : (
            <div className="mt-3 flex gap-2">
              <Button variant="danger" onClick={async () => { await deleteAll(); location.reload() }}>Yes, delete everything</Button>
              <Button variant="ghost" onClick={() => setSure(false)}>Cancel</Button>
            </div>
          )}
        </div>
        {msg && <p className="text-sm text-muted" aria-live="polite">{msg}</p>}
      </div>
    </Section>
  )
}

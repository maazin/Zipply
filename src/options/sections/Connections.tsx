import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '@/shared/types'
import { send } from '@/shared/messages'
import { getGeminiKey, getSettings, setGeminiKey, updateSettings } from '@/lib/repo'
import { usageToday } from '@/lib/usage'
import { nanoStatus, type NanoStatus } from '@/lib/nano'
import { Button, Field, Input, Spinner, Toggle } from '@/ui/kit'
import { Section } from '../App'

const NANO_TEXT: Record<NanoStatus, string> = {
  available: 'Ready on this device',
  downloadable: 'Available; Chrome downloads it on first use',
  downloading: 'Downloading',
  unavailable: "This laptop can't run it; those jobs use rules and your review instead",
  unsupported: 'Not in this Chrome version',
}

export function Connections() {
  const [s, setS] = useState<Settings | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof usageToday>>>([])
  const [nano, setNano] = useState<NanoStatus>('unsupported')

  const refresh = useCallback(async () => {
    setS(await getSettings())
    setKey(await getGeminiKey().catch(() => ''))
    setUsage(await usageToday())
    setNano(await nanoStatus())
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])

  const patch = async (p: Partial<Settings>) => setS(await updateSettings(p))

  async function run(label: string, fn: () => Promise<unknown>) {
    type R = { error?: string } | null | undefined
    setBusy(label)
    setMsg('')
    try {
      const r = (await fn()) as R
      if (r?.error) setMsg(r.error)
      await refresh()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  if (!s) return null
  return (
    <Section id="connections" title="Connections" intro="Google holds your tracker sheet and (optionally) reads recruiting email. Gemini's free tier writes drafts. Nothing here costs money.">
      <div className="flex flex-col gap-6">
        <div>
          <h3 className="text-sm font-semibold">Google Sheets</h3>
          {s.googleEmail ? (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              <span className="text-muted">Signed in as {s.googleEmail}</span>
              {s.sheetUrl && <a className="text-accent underline" href={s.sheetUrl} target="_blank" rel="noreferrer">Open your sheet</a>}
              <Button size="sm" variant="ghost" onClick={() => run('disconnect', () => send({ type: 'google:disconnect' }))}>Disconnect</Button>
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-3">
              <Button variant="primary" disabled={!!busy} onClick={() => run('connect', () => send({ type: 'google:connect' }))}>
                {busy === 'connect' && <Spinner />} Sign in with Google
              </Button>
              <span className="text-xs text-muted">Creates one sheet. Zipply can only touch files it created.</span>
            </div>
          )}
        </div>

        <div>
          <Toggle
            checked={s.gmailEnabled}
            label="Update statuses from Gmail"
            hint="Read-only. Every 2 hours, recent mail from ATS senders and companies in your sheet. Only the status and date are kept."
            onChange={(v) => run('gmail', () => send({ type: 'gmail:enable', enabled: v }))}
          />
          {s.gmailEnabled && (
            <div className="mt-2 flex items-center gap-3 pl-12 text-xs text-muted">
              <span>Last checked {s.lastGmailSync ? new Date(s.lastGmailSync).toLocaleString() : 'never'}</span>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run('sync', () => send({ type: 'gmail:sync' }))}>
                {busy === 'sync' && <Spinner />} Check now
              </Button>
            </div>
          )}
          <div className="mt-3 pl-12">
            <Toggle
              checked={s.cloudEmailFallback}
              label="Let Gemini's free API classify unclear emails"
              hint="Off by default. When off, email content never leaves this laptop."
              onChange={(v) => patch({ cloudEmailFallback: v })}
            />
          </div>
        </div>

        <div className="border-t border-line pt-6">
          <h3 className="text-sm font-semibold">AI (free only)</h3>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Gemini API key" hint={<>From <a className="underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>, in a project with no billing account.</>}>
              <Input type="password" value={key} placeholder="AIza…" onChange={(e) => setKey(e.target.value)} onBlur={() => setGeminiKey(key)} autoComplete="off" />
            </Field>
            <Field label="Gemini Nano (on device)">
              <span className="flex h-9 items-center text-sm text-muted">{NANO_TEXT[nano]}</span>
            </Field>
            <Field label="Writing model"><Input value={s.models.flash} onChange={(e) => patch({ models: { ...s.models, flash: e.target.value } })} /></Field>
            <Field label="Light model (field mapping, checks)"><Input value={s.models.flashLite} onChange={(e) => patch({ models: { ...s.models, flashLite: e.target.value } })} /></Field>
            <Field label="Daily limit, writing model"><Input type="number" min={0} value={s.dailyLimits.flash} onChange={(e) => patch({ dailyLimits: { ...s.dailyLimits, flash: Number(e.target.value) || 0 } })} /></Field>
            <Field label="Daily limit, light model"><Input type="number" min={0} value={s.dailyLimits.flashLite} onChange={(e) => patch({ dailyLimits: { ...s.dailyLimits, flashLite: Number(e.target.value) || 0 } })} /></Field>
          </div>
          <div className="mt-4">
            <Toggle checked={s.autoDraft} label="Draft open-ended answers while filling" hint="Drafts are marked in the panel and never submitted without your edit." onChange={(v) => patch({ autoDraft: v })} />
          </div>
          <div className="mt-4">
            <div className="text-[13px] font-medium">Calls today</div>
            <ul className="mt-1 flex flex-col gap-0.5 text-sm text-muted">
              {usage.map((u) => (
                <li key={u.model} className="tabular-nums">{u.model}: {u.count}{u.limit != null ? ` of ${u.limit}` : ''}</li>
              ))}
            </ul>
          </div>
        </div>

        <div className="border-t border-line pt-6">
          <Field label="Fill confidence threshold" hint="Rule matches below this go to the AI mapper, or stay blank and flagged.">
            <Input type="number" min={0.5} max={0.95} step={0.05} value={s.fillThreshold} onChange={(e) => patch({ fillThreshold: Number(e.target.value) || 0.75 })} className="w-28" />
          </Field>
        </div>
        {msg && <p className="text-sm text-bad">{msg}</p>}
      </div>
    </Section>
  )
}

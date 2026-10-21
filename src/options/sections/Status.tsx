import { useCallback, useEffect, useState } from 'react'
import { send } from '@/shared/messages'
import type { HealthCheck } from '@/background/health'
import { Button, Dot, Spinner } from '@/ui/kit'
import { Section } from '../App'

/** Is everything working? One line per moving part, and a diagnostics copy for bug reports. */
export function Status() {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const run = useCallback(async () => {
    setBusy(true)
    setNote('')
    try {
      setChecks(await send<HealthCheck[]>({ type: 'health' }))
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    run()
  }, [run])

  const problems = checks?.filter((c) => c.ok === false).length ?? 0

  return (
    <Section id="status" title="Status" intro={checks ? (problems ? `${problems} ${problems === 1 ? 'thing needs' : 'things need'} attention.` : 'Everything that is on is working.') : undefined}>
      {!checks && <div className="flex justify-center py-4 text-muted"><Spinner /></div>}
      {checks && (
        <ul className="flex flex-col gap-2 text-sm">
          {checks.map((c) => (
            <li key={c.name} className="flex items-start gap-3">
              <span className="mt-1.5"><Dot tone={c.ok === null ? 'muted' : c.ok ? 'ok' : 'bad'} /></span>
              <span className="w-28 shrink-0 font-medium">{c.name}</span>
              <span className={c.ok === false ? 'text-bad' : 'text-muted'}>{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={run}>{busy && <Spinner />} Check again</Button>
        <Button size="sm" variant="ghost" onClick={async () => {
          const d = await send<object>({ type: 'diagnostics' })
          await navigator.clipboard.writeText(JSON.stringify(d, null, 2))
          setNote('Copied. It has no profile details, companies or email content; paste it into a bug report.')
        }}>
          Copy diagnostics
        </Button>
        {note && <span className="text-xs text-muted" aria-live="polite">{note}</span>}
      </div>
    </Section>
  )
}

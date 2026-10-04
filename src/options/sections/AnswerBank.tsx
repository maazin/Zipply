import { useCallback, useEffect, useState } from 'react'
import type { AnswerBankEntry } from '@/shared/types'
import { deleteAnswer, getAnswerBank, updateAnswer } from '@/lib/repo'
import { Button, Chip, Empty, Input, TextArea } from '@/ui/kit'
import { Section } from '../App'

export function AnswerBank() {
  const [list, setList] = useState<AnswerBankEntry[]>([])
  const [q, setQ] = useState('')
  const refresh = useCallback(async () => setList(await getAnswerBank()), [])
  useEffect(() => {
    refresh()
  }, [refresh])
  const shown = list.filter((e) => !q || (e.label + ' ' + e.answer).toLowerCase().includes(q.toLowerCase()))
  return (
    <Section id="bank" title="Answer bank" intro="Questions you answer by hand on real forms land here, and the next form with a similar question fills itself. AI drafts you keep are saved too, so the same question never costs a second call.">
      {list.length > 4 && <Input placeholder="Search answers" value={q} onChange={(e) => setQ(e.target.value)} className="mb-4" />}
      {shown.length === 0 && <Empty>Nothing saved yet.</Empty>}
      <ul className="flex flex-col gap-4">
        {shown.map((e) => (
          <li key={e.id} className="flex flex-col gap-2 border-b border-line pb-4 last:border-0 last:pb-0">
            <div className="flex items-start justify-between gap-3">
              <Input value={e.label} onChange={(ev) => setList((l) => l.map((x) => (x.id === e.id ? { ...x, label: ev.target.value } : x)))} onBlur={() => updateAnswer(list.find((x) => x.id === e.id)!)} className="font-medium" />
              <div className="flex shrink-0 items-center gap-2">
                {e.source === 'ai' && <Chip>AI draft</Chip>}
                <span className="text-xs text-muted">used {e.uses}×</span>
                <Button size="sm" variant="danger" onClick={async () => { await deleteAnswer(e.id); refresh() }}>Delete</Button>
              </div>
            </div>
            <TextArea value={e.answer} rows={Math.min(8, Math.max(2, Math.ceil(e.answer.length / 90)))} onChange={(ev) => setList((l) => l.map((x) => (x.id === e.id ? { ...x, answer: ev.target.value } : x)))} onBlur={() => updateAnswer(list.find((x) => x.id === e.id)!)} />
          </li>
        ))}
      </ul>
    </Section>
  )
}

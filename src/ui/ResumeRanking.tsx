// Your resumes ranked for one job: score bars, what each covers that the best
// doesn't, and a line on why the best one wins. Click a row to use that resume.
import type { ResumeComparison } from '@/core/score/compare'
import { Chip, cx } from './kit'

export function ResumeRanking({ comparison, selected, onSelect }: { comparison: ResumeComparison; selected?: string | null; onSelect?: (id: string) => void }) {
  const { rows, bestId, close, why } = comparison
  return (
    <div className="flex flex-col gap-2" data-testid="resume-ranking">
      <ul className="flex flex-col gap-1">
        {rows.map((r) => {
          const isBest = r.resumeId === bestId
          const isSel = r.resumeId === (selected ?? bestId)
          const body = (
            <>
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.label}</span>
                {isBest && <Chip tone="ok">{close ? 'Best, narrowly' : 'Best match'}</Chip>}
                {!isBest && r.behind > 0 && <span className="text-xs text-faint tabular-nums">−{r.behind}</span>}
                <span className="w-7 text-right text-[13px] font-semibold tabular-nums">{r.score}</span>
              </span>
              <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-sunken">
                <span className={cx('block h-full rounded-full', isBest ? 'bg-ok' : 'bg-faint')} style={{ width: `${Math.max(2, Math.min(100, r.score))}%` }} />
              </span>
              {!isBest && (r.edge.length > 0 || r.lacks.length > 0) && (
                <span className="mt-1 block text-xs text-muted">
                  {r.edge.length > 0 && <>Has {r.edge.slice(0, 3).join(', ')}{r.lacks.length > 0 ? '; ' : ''}</>}
                  {r.lacks.length > 0 && <>missing {r.lacks.slice(0, 3).join(', ')}</>}
                </span>
              )}
            </>
          )
          return (
            <li key={r.resumeId}>
              {onSelect ? (
                <button
                  onClick={() => onSelect(r.resumeId)}
                  aria-pressed={isSel}
                  className={cx('block w-full rounded-lg border px-2.5 py-2 text-left', isSel ? 'border-accent' : 'border-transparent hover:bg-sunken')}
                >
                  {body}
                </button>
              ) : (
                <div className="px-0.5 py-1.5">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
      {why && rows.length > 1 && <p className="text-xs text-muted">{why}</p>}
    </div>
  )
}

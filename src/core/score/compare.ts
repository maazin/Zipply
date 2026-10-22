// Side-by-side view of how each of your resumes fits one posting: which is
// best, by how much, and what each one covers that the others don't.
import type { MatchResult } from '@/shared/types'

/** Within this many points, two resumes are about as good as each other. */
export const CLOSE = 3

export interface RankedResume {
  resumeId: string
  /** Tag if set, else the file name. */
  label: string
  score: number
  /** Points behind the best (0 for the best). */
  behind: number
  /** Posting terms this resume has that the best one doesn't. */
  edge: string[]
  /** Posting terms the best one has that this resume doesn't. */
  lacks: string[]
}

export interface ResumeComparison {
  bestId: string | null
  /** The top two are within CLOSE points of each other. */
  close: boolean
  /** One sentence on why the best one is best. */
  why: string
  rows: RankedResume[]
}

type Scored = Pick<MatchResult, 'resumeId' | 'score' | 'matched'> & { tag?: string; name?: string }

const labelOf = (m: Scored) => m.tag?.trim() || m.name || 'Resume'
const list = (terms: string[]) => terms.slice(0, 3).join(', ')

/** Best first: higher score, then more posting terms matched. */
export function byFit<T extends Scored>(a: T, b: T): number {
  return b.score - a.score || b.matched.length - a.matched.length
}

export function compareResumes(matches: Scored[]): ResumeComparison {
  const sorted = [...matches].sort(byFit)
  const best = sorted[0]
  if (!best) return { bestId: null, close: false, why: '', rows: [] }
  const bestSet = new Set(best.matched)
  const rows = sorted.map((m) => {
    const own = new Set(m.matched)
    return {
      resumeId: m.resumeId,
      label: labelOf(m),
      score: m.score,
      behind: best.score - m.score,
      edge: m.matched.filter((t) => !bestSet.has(t)),
      lacks: best.matched.filter((t) => !own.has(t)),
    }
  })
  const second = rows[1]
  if (!second) return { bestId: best.resumeId, close: false, why: 'Your only resume.', rows }

  const name = labelOf(best)
  const close = second.behind < CLOSE
  // What the best covers that the runner-up doesn't, and the reverse.
  const wins = second.lacks
  let why: string
  if (close) {
    why = second.behind === 0 ? `${name} and ${second.label} fit equally well` : `${name} and ${second.label} are within ${second.behind} point${second.behind === 1 ? '' : 's'}`
    why += second.edge.length ? `. ${second.label} covers ${list(second.edge)}, so pick the one that suits this role.` : '. Either works.'
  } else {
    why = `${name} scores ${second.behind} points above ${second.label}`
    why += wins.length ? `: it covers ${list(wins)}.` : ': its sections and skills are more complete.'
  }
  return { bestId: best.resumeId, close, why, rows }
}

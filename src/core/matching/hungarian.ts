/**
 * Hungarian algorithm (Kuhn-Munkres) for the rectangular assignment problem.
 * Returns, for each row, the assigned column or -1. Minimizes total cost.
 * Idea from FormFilla: pair fields and profile values across the whole form at
 * once, so two similar fields can't both claim "Phone".
 */
export function hungarian(cost: number[][]): number[] {
  const rows = cost.length
  if (!rows) return []
  const cols = cost[0].length
  if (!cols) return new Array(rows).fill(-1)
  const n = Math.max(rows, cols)
  const BIG = 1e9
  // Square, 1-indexed matrix padded with a large cost.
  const a: number[][] = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i >= 1 && j >= 1 && i <= rows && j <= cols ? cost[i - 1][j - 1] : i && j ? BIG / 1000 : 0)),
  )
  const u = new Array(n + 1).fill(0)
  const v = new Array(n + 1).fill(0)
  const p = new Array(n + 1).fill(0)
  const way = new Array(n + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array(n + 1).fill(Infinity)
    const used = new Array(n + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = a[i0][j] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }
  const result = new Array(rows).fill(-1)
  for (let j = 1; j <= n; j++) {
    const i = p[j]
    if (i >= 1 && i <= rows && j <= cols) result[i - 1] = j - 1
  }
  return result
}

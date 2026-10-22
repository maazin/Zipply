// The one-line summary at the top of the panel.

/** "1 offer · 2 status updates · 1 to log · 3 emails to sort" */
export function sinceSummary(n: { updates: number; offers: number; conflicts: number; unlogged: number; emails: number }): string {
  const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  return [
    n.offers ? plural(n.offers, 'offer', 'offers') : '',
    n.updates ? plural(n.updates, 'status update', 'status updates') : '',
    n.conflicts ? plural(n.conflicts, 'to check', 'to check') : '',
    n.unlogged ? `${n.unlogged} to log` : '',
    n.emails ? plural(n.emails, 'email to sort', 'emails to sort') : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

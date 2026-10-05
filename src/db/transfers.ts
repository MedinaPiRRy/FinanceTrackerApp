import type { Db } from './open'
import { daysBetween } from '../core/dates'

/**
 * Links the two halves of a transfer (e.g. a chequing "payment to card" and the card's "payment received"):
 * equal and opposite amounts, different accounts, within 7 days. Safe to run repeatedly; only unlinked rows are touched.
 */
export function pairTransfers(db: Db, profileId: number): number {
  const open = db.prepare(`SELECT id, account_id AS acc, posted_date AS d, amount_cents AS c FROM txn WHERE profile_id = ? AND kind = 'transfer' AND transfer_group IS NULL ORDER BY posted_date, id`).all(profileId) as { id: number; acc: number; d: string; c: number }[]
  const used = new Set<number>()
  const set = db.prepare('UPDATE txn SET transfer_group = ? WHERE id = ?')
  let pairs = 0
  db.transaction(() => {
    for (const a of open) {
      if (used.has(a.id)) continue
      let best: (typeof open)[number] | undefined
      let bestDist = Infinity
      for (const b of open) {
        if (b.id === a.id || used.has(b.id) || b.acc === a.acc || b.c !== -a.c) continue
        const dist = Math.abs(daysBetween(a.d, b.d))
        if (dist <= 7 && dist < bestDist) { best = b; bestDist = dist }
      }
      if (best) {
        used.add(a.id)
        used.add(best.id)
        const g = `xfer-${Math.min(a.id, best.id)}`
        set.run(g, a.id)
        set.run(g, best.id)
        pairs++
      }
    }
  })()
  return pairs
}

// Choosing what counts as taxes or interest, one payment or one account at a time (a whole category is set with setCategoryPurpose).
import type { Db } from './open'
import { BULK_LIMIT } from './queries'
import type { Purpose } from '../core/costs'

/**
 * Marks payments as taxes, as interest, or as "not counted" on the Taxes & interest page; `null` takes the mark off so the payment is judged
 * automatically again. The payment's own mark beats its category and its account. Only income, spending and refund lines can be marked:
 * a transfer is movement between your accounts, and a line still waiting in Review has to be decided there first.
 */
export function markCosts(db: Db, txnIds: number[], purpose: Purpose | null): { updated: number } {
  const ids = [...new Set(txnIds)]
  if (ids.length === 0) throw new Error('Select at least one payment first.')
  if (ids.length > BULK_LIMIT) throw new Error(`Select at most ${BULK_LIMIT} payments at a time.`)
  if (purpose !== null && !['tax', 'interest', 'none'].includes(purpose)) throw new Error('Choose Taxes, Interest or Not counted.')
  const rows = db.prepare(`SELECT id, kind FROM txn WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: number; kind: string }[]
  if (rows.length !== ids.length) throw new Error('Some of those payments no longer exist. Reload the page.')
  const bad = rows.filter((r) => !['income', 'expense', 'refund'].includes(r.kind)).length
  if (bad > 0) throw new Error(`${bad.toLocaleString()} of the selected ${bad === 1 ? 'line is a transfer or is still waiting in Review' : 'lines are transfers or still waiting in Review'}. A transfer is only movement between your accounts, so mark the spending or income line instead, and decide waiting lines in Review first.`)
  db.transaction(() => { const upd = db.prepare('UPDATE txn SET cost_purpose = ? WHERE id = ?'); for (const r of rows) upd.run(purpose, r.id) })()
  return { updated: rows.length }
}

/** Takes a whole account out of the Taxes & interest page (or puts it back). Payments marked one by one still count. */
export function setAccountCostsExcluded(db: Db, accountId: number, excluded: boolean): void {
  const r = db.prepare('UPDATE account SET costs_excluded = ? WHERE id = ?').run(excluded ? 1 : 0, accountId)
  if (r.changes === 0) throw new Error('That account no longer exists. Reload the page.')
}

/** Sets what a whole category counts as, from the Taxes & interest page (the same setting as Settings → Categories). `null` goes back to guessing from the name. */
export function setCostCategory(db: Db, categoryId: number, purpose: Purpose | null): void {
  if (purpose !== null && !['tax', 'interest', 'none'].includes(purpose)) throw new Error('Choose Taxes, Interest or Not counted.')
  const r = db.prepare('UPDATE category SET purpose = ? WHERE id = ?').run(purpose, categoryId)
  if (r.changes === 0) throw new Error('That category no longer exists. Reload the page.')
}

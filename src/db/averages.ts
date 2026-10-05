import type { Db } from './open'
import { lastCompleteMonths, monthEnd, monthStart } from '../core/budgets'

/** Average monthly income and spending over the last (up to three) complete months that have data, for one or more profiles. */
export function recentAverages(db: Db, ids: number[], today: string) {
  const marks = ids.map(() => '?').join(',')
  const months = lastCompleteMonths(today, 3).filter((m) => db.prepare(`SELECT 1 FROM txn WHERE profile_id IN (${marks}) AND kind IN ('income','expense','refund') AND posted_date BETWEEN ? AND ? LIMIT 1`).get(...ids, monthStart(m), monthEnd(m)))
  if (months.length === 0) return { months, income: null, spend: null }
  const sum = (kinds: string, sign: number, m: string) => (db.prepare(`SELECT COALESCE(SUM(amount_cents),0) s FROM txn WHERE profile_id IN (${marks}) AND kind IN (${kinds}) AND posted_date BETWEEN ? AND ?`).get(...ids, monthStart(m), monthEnd(m)) as { s: number }).s * sign
  const income = months.reduce((a, m) => a + sum("'income'", 1, m), 0) / months.length
  const spend = months.reduce((a, m) => a + sum("'expense','refund'", -1, m), 0) / months.length
  return { months, income: Math.round(income), spend: Math.max(0, Math.round(spend)) }
}


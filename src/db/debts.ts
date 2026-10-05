import type { Db } from './open'

const iso = /^\d{4}-\d{2}-\d{2}$/

export function createDebt(db: Db, profileId: number, name: string, balanceCents: number, asOf: string, notes?: string): number {
  if (!name.trim()) throw new Error('Give the debt a name')
  if (!Number.isInteger(balanceCents) || balanceCents < 0) throw new Error('The balance cannot be negative')
  if (!iso.test(asOf)) throw new Error('Date must be YYYY-MM-DD')
  return db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO debt (profile_id, name, balance_cents, as_of, notes) VALUES (?,?,?,?,?)').run(profileId, name.trim(), balanceCents, asOf, notes ?? null).lastInsertRowid)
    db.prepare('INSERT INTO debt_history (debt_id, as_of, balance_cents) VALUES (?,?,?)').run(id, asOf, balanceCents)
    return id
  })()
}

/** Records a new balance. The previous balance is kept in the history so progress over time can be shown. */
export function updateDebtBalance(db: Db, profileId: number, debtId: number, balanceCents: number, asOf: string): void {
  if (!Number.isInteger(balanceCents) || balanceCents < 0) throw new Error('The balance cannot be negative')
  if (!iso.test(asOf)) throw new Error('Date must be YYYY-MM-DD')
  const d = db.prepare('SELECT balance_cents b, as_of a FROM debt WHERE id = ? AND profile_id = ?').get(debtId, profileId) as { b: number; a: string } | undefined
  if (!d) throw new Error('That debt no longer exists. Reload the page.')
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO debt_history (debt_id, as_of, balance_cents) VALUES (?,?,?)').run(debtId, d.a, d.b) // keep what it was
    db.prepare('INSERT INTO debt_history (debt_id, as_of, balance_cents) VALUES (?,?,?) ON CONFLICT(debt_id, as_of) DO UPDATE SET balance_cents = excluded.balance_cents').run(debtId, asOf, balanceCents)
    // the "current" balance is the one with the latest date
    const latest = db.prepare('SELECT as_of a, balance_cents b FROM debt_history WHERE debt_id = ? ORDER BY as_of DESC LIMIT 1').get(debtId) as { a: string; b: number }
    db.prepare('UPDATE debt SET balance_cents = ?, as_of = ? WHERE id = ?').run(latest.b, latest.a, debtId)
  })()
}

export function debtHistory(db: Db, profileId: number, debtId: number): { asOf: string; balanceCents: number }[] {
  if (!db.prepare('SELECT 1 FROM debt WHERE id = ? AND profile_id = ?').get(debtId, profileId)) throw new Error('That debt no longer exists. Reload the page.')
  return db.prepare('SELECT as_of AS asOf, balance_cents AS balanceCents FROM debt_history WHERE debt_id = ? ORDER BY as_of').all(debtId) as { asOf: string; balanceCents: number }[]
}

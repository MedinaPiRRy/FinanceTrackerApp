// Payments that count toward a loan the person tracks (a student loan, a car loan...). A payment is still an ordinary expense in
// its category; linking it also lowers the loan's balance, so the app tracks the real loan.
//
// How the balance moves: the loan has a balance "as of" a date (typed by the person, or lowered by an earlier payment). A payment
// dated after that date lowers it, and the new balance is recorded on the payment's date in the loan's history. A payment dated on
// or before the balance's date is already part of that balance, so it is linked (for the record) without lowering anything.
// Interest is not modelled: when the lender shows a new balance, type it in and it takes over.
import type { Db } from './open'
import { updateDebtBalance } from './debts'

export interface DebtPaymentRow { txnId: number; date: string; description: string; amountCents: number; appliedCents: number }

/** Counts an expense toward a loan. Returns how much the loan's balance went down (0 when the payment was already reflected). */
export function linkPaymentToDebt(db: Db, txnId: number, debtId: number): { appliedCents: number } {
  const t = db.prepare('SELECT id, profile_id AS p, posted_date AS date, amount_cents AS cents, kind FROM txn WHERE id = ?').get(txnId) as { id: number; p: number; date: string; cents: number; kind: string } | undefined
  if (!t) throw new Error('That transaction no longer exists. Reload the page.')
  const d = db.prepare('SELECT id, name, profile_id AS p, balance_cents AS b, as_of AS a FROM debt WHERE id = ?').get(debtId) as { id: number; name: string; p: number; b: number; a: string } | undefined
  if (!d) throw new Error('That loan no longer exists. Reload the page.')
  if (t.kind !== 'expense' || t.cents >= 0) throw new Error('Only money paid out (an expense) can count toward a loan.')
  if (t.p !== d.p) throw new Error('That loan belongs to someone else.')
  const already = db.prepare('SELECT d.name FROM debt_payment dp JOIN debt d ON d.id = dp.debt_id WHERE dp.txn_id = ?').get(txnId) as { name: string } | undefined
  if (already) throw new Error(`This payment already counts toward "${already.name}". Remove that first.`)
  return db.transaction(() => {
    let applied = 0
    // a balance dated the same day counts as already reflecting this payment, unless that balance was itself made by another payment that day
    const lowerSameDay = t.date === d.a && !!db.prepare('SELECT 1 FROM debt_payment dp JOIN txn x ON x.id = dp.txn_id WHERE dp.debt_id = ? AND x.posted_date = ? AND dp.applied_cents > 0').get(d.id, t.date)
    if (t.date > d.a || lowerSameDay) {
      const next = Math.max(0, d.b + t.cents) // cents is negative
      applied = d.b - next
      updateDebtBalance(db, d.p, d.id, next, t.date)
    }
    db.prepare('INSERT INTO debt_payment (txn_id, debt_id, applied_cents) VALUES (?,?,?)').run(txnId, debtId, applied)
    return { appliedCents: applied }
  })()
}

/**
 * Stops counting a payment toward its loan. If it lowered the balance and that balance is still the latest, the amount is put back;
 * if the person has recorded a newer balance since, that newer balance is left alone (it already took over).
 */
export function unlinkPayment(db: Db, txnId: number): { restoredCents: number } {
  const l = db.prepare('SELECT dp.debt_id AS debtId, dp.applied_cents AS applied, d.profile_id AS p, d.balance_cents AS b, d.as_of AS a, t.posted_date AS date FROM debt_payment dp JOIN debt d ON d.id = dp.debt_id JOIN txn t ON t.id = dp.txn_id WHERE dp.txn_id = ?').get(txnId) as { debtId: number; applied: number; p: number; b: number; a: string; date: string } | undefined
  if (!l) throw new Error('That payment is not counted toward a loan.')
  return db.transaction(() => {
    let restored = 0
    if (l.applied > 0 && l.a === l.date) { // the balance on the payment's own date is still the latest
      restored = l.applied
      updateDebtBalance(db, l.p, l.debtId, l.b + l.applied, l.a)
    }
    db.prepare('DELETE FROM debt_payment WHERE txn_id = ?').run(txnId)
    return { restoredCents: restored }
  })()
}

export function listDebtPayments(db: Db, profileId: number, debtId: number): DebtPaymentRow[] {
  if (!db.prepare('SELECT 1 FROM debt WHERE id = ? AND profile_id = ?').get(debtId, profileId)) throw new Error('That loan no longer exists. Reload the page.')
  return db.prepare('SELECT t.id AS txnId, t.posted_date AS date, t.description, -t.amount_cents AS amountCents, dp.applied_cents AS appliedCents FROM debt_payment dp JOIN txn t ON t.id = dp.txn_id WHERE dp.debt_id = ? ORDER BY t.posted_date DESC, t.id DESC').all(debtId) as DebtPaymentRow[]
}

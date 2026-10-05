// Charges that the bank reverses: a monthly account fee and, a moment later, a "fee rebate" for the same amount.
// The spending totals already net these out (the rebate is a refund in the same category). This module finds the pairs so
// the rest of the app can stop treating the charge as a real cost: it is not a recurring bill, an unusual purchase or a big expense.
import { daysBetween } from './dates'

export interface PairTxn {
  id: number
  date: string
  amountCents: number
  kind: string
  category: string | null
  accountId: number
}

/** A rebate has to arrive within this many days of the charge (either side: banks sometimes post the rebate first). */
export const MAX_REVERSAL_DAYS = 7
/** A recurring charge counts as "refunded" when at least this share of its occurrences was reversed. */
export const REFUNDED_SHARE = 0.7

/**
 * Pairs each expense with a refund of exactly the same amount, in the same account and the same category, within a week.
 * Matching on the category as well as the amount keeps a friend who happens to send $17 from cancelling a $17 bill.
 * Each refund is used once; the closest one in time wins. Returns charge id -> refund id.
 */
export function pairReversals(txns: PairTxn[]): Map<number, number> {
  const credits = txns.filter((t) => t.kind === 'refund' && t.amountCents > 0)
  const charges = txns.filter((t) => t.kind === 'expense' && t.amountCents < 0)
  const options: { charge: PairTxn; credit: PairTxn; gap: number }[] = []
  for (const d of charges) {
    for (const c of credits) {
      if (c.accountId !== d.accountId || c.amountCents !== -d.amountCents || c.category !== d.category) continue
      const gap = Math.abs(daysBetween(d.date, c.date))
      if (gap <= MAX_REVERSAL_DAYS) options.push({ charge: d, credit: c, gap })
    }
  }
  // closest pairs first, so a rebate goes to the charge it really belongs to
  options.sort((a, b) => a.gap - b.gap || a.charge.date.localeCompare(b.charge.date) || a.charge.id - b.charge.id || a.credit.id - b.credit.id)
  const usedCredits = new Set<number>()
  const out = new Map<number, number>()
  for (const o of options) {
    if (usedCredits.has(o.credit.id) || out.has(o.charge.id)) continue
    usedCredits.add(o.credit.id)
    out.set(o.charge.id, o.credit.id)
  }
  return out
}

/** Every transaction that is half of a reversal pair (the charge and its refund). */
export function reversedIds(pairs: Map<number, number>): Set<number> {
  return new Set([...pairs.keys(), ...pairs.values()])
}

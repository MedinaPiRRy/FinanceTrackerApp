// "How is paying this loan off going?": what was owed, what is owed now, every payment made toward it, and how fast.
import type { Db } from './open'
import { listDebtPayments, type DebtPaymentRow } from './debtPayments'
import { debtHistory } from './debts'
import { addMonths, monthKey } from '../core/dates'

export interface DebtDetail {
  id: number
  name: string
  notes: string | null
  balanceCents: number
  asOf: string
  /** The first balance on record, and when. */
  startCents: number
  startAsOf: string
  paidDownCents: number
  /** Share of the first balance paid off so far (0 to 1), or null if it started at zero. */
  percentPaid: number | null
  payments: DebtPaymentRow[]
  paymentsTotalCents: number
  /** Average paid per month over the last six months with payments, or null with no payments to go on. */
  monthlyAverageCents: number | null
  /** About how many more months at that pace (interest is not counted), or null if it cannot be said. */
  monthsLeft: number | null
  history: { asOf: string; balanceCents: number }[]
}

export function debtDetail(db: Db, profileId: number, debtId: number, today: string): DebtDetail {
  const d = db.prepare('SELECT id, name, notes, balance_cents AS balanceCents, as_of AS asOf FROM debt WHERE id = ? AND profile_id = ?').get(debtId, profileId) as { id: number; name: string; notes: string | null; balanceCents: number; asOf: string } | undefined
  if (!d) throw new Error('That loan no longer exists. Reload the page.')
  const history = debtHistory(db, profileId, debtId)
  const first = history[0] ?? { asOf: d.asOf, balanceCents: d.balanceCents }
  const payments = listDebtPayments(db, profileId, debtId)
  // average over the last six months that had a payment, counting the months in between that had none
  const months = payments.map((p) => monthKey(p.date)).sort()
  let monthlyAverageCents: number | null = null
  if (months.length > 0) {
    const from = [addMonths(monthKey(today), -5), months[0]!].sort().pop()! // the later of "six months ago" and the first payment's month
    const span = monthsBetween(from, monthKey(today)) + 1
    const recent = payments.filter((p) => monthKey(p.date) >= from)
    monthlyAverageCents = Math.round(recent.reduce((s, p) => s + p.amountCents, 0) / Math.max(1, span))
  }
  const monthsLeft = monthlyAverageCents && monthlyAverageCents > 0 && d.balanceCents > 0 ? Math.ceil(d.balanceCents / monthlyAverageCents) : d.balanceCents === 0 ? 0 : null
  return {
    ...d, startCents: first.balanceCents, startAsOf: first.asOf, paidDownCents: Math.max(0, first.balanceCents - d.balanceCents),
    percentPaid: first.balanceCents > 0 ? Math.max(0, Math.min(1, (first.balanceCents - d.balanceCents) / first.balanceCents)) : null,
    payments, paymentsTotalCents: payments.reduce((s, p) => s + p.amountCents, 0), monthlyAverageCents, monthsLeft, history
  }
}

const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7))

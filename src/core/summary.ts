import { monthKey } from './dates'

export type TxnKind = 'income' | 'expense' | 'refund' | 'transfer' | 'unclassified'

export interface SummaryTxn {
  date: string
  amountCents: number // signed: + money in, - money out (credit-card charge = negative)
  kind: TxnKind
  category: string | null
}

export interface MonthSummary {
  month: string
  incomeCents: number
  expenseCents: number // net of refunds, positive number
  netCents: number
  savingsRate: number | null // net / income, null when no income
  byCategory: Record<string, number>
}

/**
 * Spending = expenses minus refunds. Income = income rows. Transfers and
 * unclassified rows never count (card payments, moves between own accounts).
 */
export function summarizeMonth(txns: SummaryTxn[], month: string): MonthSummary {
  let income = 0
  let expense = 0
  const byCategory: Record<string, number> = {}
  for (const t of txns) {
    if (monthKey(t.date) !== month) continue
    if (t.kind === 'income') income += t.amountCents
    else if (t.kind === 'expense' || t.kind === 'refund') {
      expense += -t.amountCents
      const c = t.category ?? 'Uncategorized'
      byCategory[c] = (byCategory[c] ?? 0) - t.amountCents
    }
  }
  const net = income - expense
  return { month, incomeCents: income, expenseCents: expense, netCents: net, savingsRate: income > 0 ? net / income : null, byCategory }
}

// Debt payoff planning. Pure and deterministic: the same debts and the same monthly budget always give the same schedule.
// Interest is charged monthly at APR/12 on the balance carried into the month; payments are made after interest.
import { addMonths, monthKey } from './dates'

export type Strategy = 'avalanche' | 'snowball' | 'minimum'

export interface PlanDebt {
  id: string
  label: string
  /** What is owed now, positive. */
  balanceCents: number
  /** Annual interest rate in basis points: 1999 = 19.99%. */
  aprBps: number
  minPaymentCents: number
}

export interface DebtMonth { id: string; paidCents: number; interestCents: number; balanceCents: number }
export interface PayoffMonth { index: number; month: string; debts: DebtMonth[]; paidCents: number; interestCents: number; balanceCents: number }

export interface PayoffResult {
  strategy: Strategy
  /** The monthly amount actually used (never below the minimums, except "minimum" which ignores the budget). */
  monthlyBudgetCents: number
  /** Months until everything is paid; null if it would not finish within the limit (the minimums do not cover the interest). */
  months: number | null
  debtFreeMonth: string | null
  totalInterestCents: number
  totalPaidCents: number
  /** Order in which debts reach zero. */
  order: { id: string; label: string; paidOffMonth: string }[]
  schedule: PayoffMonth[]
  warnings: string[]
}

export const MAX_MONTHS = 600
const STEP = 500

export const DEFAULT_CARD_APR_BPS = 1999
/** Sensible defaults when the person has not entered terms: a card minimum is the larger of $25 and 3%; a loan is spread over three years. */
export const defaultMinPayment = (balanceCents: number, type: 'card' | 'loan') =>
  Math.min(balanceCents, type === 'card' ? Math.max(2500, Math.ceil(balanceCents * 0.03)) : Math.ceil(balanceCents / 36 / STEP) * STEP)

const interestFor = (balance: number, aprBps: number) => Math.round((balance * aprBps) / 10000 / 12)

/** One month of payments. Shared by the payoff planner and the cash-flow forecast so they can never disagree. */
export function stepDebts(
  balances: { id: string; balanceCents: number; aprBps: number; minPaymentCents: number; label?: string }[],
  budgetCents: number,
  strategy: Strategy
): { id: string; paidCents: number; interestCents: number; balanceCents: number }[] {
  const rows = balances.map((d) => {
    const interest = d.balanceCents > 0 ? interestFor(d.balanceCents, d.aprBps) : 0
    const owed = d.balanceCents + interest
    const min = Math.min(owed, d.minPaymentCents)
    return { id: d.id, aprBps: d.aprBps, balance: d.balanceCents, interest, owed, paid: min }
  })
  if (strategy !== 'minimum') {
    let extra = Math.max(0, budgetCents - rows.reduce((s, r) => s + r.paid, 0))
    const order = [...rows].filter((r) => r.owed > r.paid).sort((a, b) => (strategy === 'avalanche' ? b.aprBps - a.aprBps || a.owed - b.owed : a.owed - b.owed || b.aprBps - a.aprBps))
    for (const r of order) {
      if (extra <= 0) break
      const add = Math.min(extra, r.owed - r.paid)
      r.paid += add
      extra -= add
    }
  }
  return rows.map((r) => ({ id: r.id, paidCents: r.paid, interestCents: r.interest, balanceCents: r.owed - r.paid }))
}

/** The monthly total that makes sense when the person has not chosen one: the minimums, or 60% of what is left over each month if that is more. */
export function defaultBudget(debts: PlanDebt[], surplusCents: number | null): number {
  const mins = debts.reduce((s, d) => s + Math.min(d.balanceCents, d.minPaymentCents), 0)
  const owed = debts.reduce((s, d) => s + d.balanceCents, 0)
  if (surplusCents === null || surplusCents <= 0) return mins
  const share = Math.floor((surplusCents * 0.6) / STEP) * STEP
  return Math.max(mins, Math.min(share, Math.ceil(owed / STEP) * STEP))
}

export function planPayoff(debts: PlanDebt[], opts: { strategy: Strategy; monthlyBudgetCents: number; startMonth: string }): PayoffResult {
  const live = debts.filter((d) => d.balanceCents > 0)
  const mins = live.reduce((s, d) => s + Math.min(d.balanceCents, d.minPaymentCents), 0)
  const warnings: string[] = []
  let budget = opts.strategy === 'minimum' ? mins : opts.monthlyBudgetCents
  if (opts.strategy !== 'minimum' && budget < mins) {
    warnings.push('The monthly amount was below the minimum payments, so the minimums are used.')
    budget = mins
  }
  let state = live.map((d) => ({ id: d.id, label: d.label, balanceCents: d.balanceCents, aprBps: d.aprBps, minPaymentCents: d.minPaymentCents }))
  const schedule: PayoffMonth[] = []
  const order: PayoffResult['order'] = []
  let totalInterest = 0
  let totalPaid = 0
  let months: number | null = null
  for (let i = 1; i <= MAX_MONTHS && state.length > 0; i++) {
    const month = addMonths(monthKey(`${opts.startMonth}-01`), i - 1)
    const res = stepDebts(state, budget, opts.strategy)
    const paid = res.reduce((s, r) => s + r.paidCents, 0)
    const interest = res.reduce((s, r) => s + r.interestCents, 0)
    totalInterest += interest
    totalPaid += paid
    for (const r of res) if (r.balanceCents === 0) order.push({ id: r.id, label: state.find((s) => s.id === r.id)!.label, paidOffMonth: month })
    state = state.filter((s) => res.find((r) => r.id === s.id)!.balanceCents > 0).map((s) => ({ ...s, balanceCents: res.find((r) => r.id === s.id)!.balanceCents }))
    schedule.push({ index: i, month, debts: res, paidCents: paid, interestCents: interest, balanceCents: state.reduce((a, s) => a + s.balanceCents, 0) })
    if (state.length === 0) months = i
  }
  if (months === null && live.length > 0) {
    warnings.push(`At this amount the debts would not be paid off within ${MAX_MONTHS / 12} years: the payments barely cover the interest. Raise the monthly amount.`)
  }
  return {
    strategy: opts.strategy, monthlyBudgetCents: budget, months, debtFreeMonth: months === null ? null : schedule[months - 1]!.month,
    totalInterestCents: totalInterest, totalPaidCents: totalPaid, order, schedule: months === null ? schedule.slice(0, 120) : schedule, warnings
  }
}

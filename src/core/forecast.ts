// Cash-flow forecast. Pure and deterministic. It walks forward month by month from today's balances using the
// person's own income, bills and spending, so the answer to "what happens if..." is just the same walk with different numbers.
import { addMonths } from './dates'
import { stepDebts, type PlanDebt, type Strategy } from './debtPlan'

export interface IncomeStream {
  id: string
  label: string
  /** regular = arrives on a schedule (pay, a fixed contract); irregular = varies (freelance, tips, selling things, a side business). */
  kind: 'regular' | 'irregular'
  /** The expected monthly amount. */
  monthlyCents: number
  /** A poor and a good month, from history. Only irregular streams differ from the expected amount. */
  lowCents: number
  highCents: number
  /** First month (0 = the first forecast month) this applies, and the last (null = for ever). */
  fromIndex?: number
  toIndex?: number | null
}

export interface ExpenseLine {
  id: string
  label: string
  kind: 'bill' | 'everyday'
  monthlyCents: number
  fromIndex?: number
  toIndex?: number | null
}

export interface GoalSaving { id: string; label: string; monthlyCents: number; remainingCents: number }
export interface OneTime { label: string; index: number; /** positive = money in, negative = money out */ cents: number }

export interface ForecastInput {
  /** First forecast month, YYYY-MM. The walk starts from today's balances. */
  startMonth: string
  months: number
  /** Cash in the bank, savings accounts and the cash wallet. */
  startCashCents: number
  startInvestmentsCents: number
  debts: PlanDebt[]
  strategy: Strategy
  /** Total paid toward debts each month. */
  debtBudgetCents: number
  income: IncomeStream[]
  expenses: ExpenseLine[]
  goals: GoalSaving[]
  oneTime?: OneTime[]
}

export interface ForecastMonth {
  index: number
  month: string
  incomeCents: number
  expenseCents: number
  goalCents: number
  debtPaidCents: number
  interestCents: number
  /** Money available to spend after setting aside goal money. */
  cashCents: number
  setAsideCents: number
  debtCents: number
  netWorthCents: number
}

export interface ForecastCase {
  months: ForecastMonth[]
  /** First month the spendable cash goes below zero; null if it never does. */
  firstShortfall: string | null
  lowestCash: { month: string; cents: number }
  debtFreeMonth: string | null
  goalDone: { id: string; label: string; month: string | null }[]
  totalInterestCents: number
}

export interface ForecastResult {
  expected: ForecastCase
  /** Irregular income at a poor month's level / a good month's level. Equal to expected when there is no irregular income. */
  low: ForecastCase
  high: ForecastCase
}

const active = (from: number | undefined, to: number | null | undefined, i: number) => i >= (from ?? 0) && (to === null || to === undefined || i <= to)

function walk(input: ForecastInput, pick: (s: IncomeStream) => number): ForecastCase {
  let cash = input.startCashCents
  let setAside = 0
  let debts = input.debts.filter((d) => d.balanceCents > 0).map((d) => ({ ...d }))
  const goals = input.goals.map((g) => ({ ...g, left: g.remainingCents, done: g.remainingCents <= 0 ? input.startMonth : (null as string | null) }))
  const out: ForecastMonth[] = []
  let firstShortfall: string | null = null
  let debtFree: string | null = debts.length === 0 ? input.startMonth : null
  let lowest = { month: input.startMonth, cents: cash }
  let totalInterest = 0
  for (let i = 0; i < input.months; i++) {
    const month = addMonths(input.startMonth, i)
    const income = input.income.filter((s) => active(s.fromIndex, s.toIndex, i)).reduce((a, s) => a + pick(s), 0) + (input.oneTime ?? []).filter((o) => o.index === i && o.cents > 0).reduce((a, o) => a + o.cents, 0)
    const expense = input.expenses.filter((e) => active(e.fromIndex, e.toIndex, i)).reduce((a, e) => a + e.monthlyCents, 0) + (input.oneTime ?? []).filter((o) => o.index === i && o.cents < 0).reduce((a, o) => a - o.cents, 0)

    let goalPut = 0
    for (const g of goals) {
      if (g.left <= 0) continue
      const put = Math.min(g.monthlyCents, g.left)
      g.left -= put
      goalPut += put
      if (g.left <= 0 && g.done === null) g.done = month
    }

    const res = debts.length ? stepDebts(debts, input.debtBudgetCents, input.strategy) : []
    const paid = res.reduce((a, r) => a + r.paidCents, 0)
    const interest = res.reduce((a, r) => a + r.interestCents, 0)
    totalInterest += interest
    debts = debts.map((d) => ({ ...d, balanceCents: res.find((r) => r.id === d.id)!.balanceCents })).filter((d) => d.balanceCents > 0)
    if (debts.length === 0 && debtFree === null) debtFree = month

    cash += income - expense - goalPut - paid
    setAside += goalPut
    const debtTotal = debts.reduce((a, d) => a + d.balanceCents, 0)
    if (cash < 0 && firstShortfall === null) firstShortfall = month
    if (cash < lowest.cents) lowest = { month, cents: cash }
    out.push({ index: i, month, incomeCents: income, expenseCents: expense, goalCents: goalPut, debtPaidCents: paid, interestCents: interest, cashCents: cash, setAsideCents: setAside, debtCents: debtTotal, netWorthCents: cash + setAside + input.startInvestmentsCents - debtTotal })
  }
  return { months: out, firstShortfall, lowestCash: lowest, debtFreeMonth: debtFree, goalDone: goals.map((g) => ({ id: g.id, label: g.label, month: g.done })), totalInterestCents: totalInterest }
}

/** Runs the forecast three times: expected income, and irregular income at its poorer and better levels. */
export function projectForecast(input: ForecastInput): ForecastResult {
  return {
    expected: walk(input, (s) => s.monthlyCents),
    low: walk(input, (s) => (s.kind === 'irregular' ? Math.min(s.lowCents, s.monthlyCents) : s.monthlyCents)),
    high: walk(input, (s) => (s.kind === 'irregular' ? Math.max(s.highCents, s.monthlyCents) : s.monthlyCents))
  }
}

// ---------------------------------------------------------------- what-if

export interface WhatIf {
  /** Start from today's pace ("current"), or from the plan that follows your budgets, goals and debt planner. */
  base: 'current' | 'plan'
  /** Percent change applied to all income and to everyday spending (bills are changed one by one). */
  incomePct: number
  spendPct: number
  /** Extra paid toward debts each month. */
  extraDebtCents: number
  /** Edits to individual lines (by id): switch off, or set a new monthly amount. */
  lines: { id: string; enabled?: boolean; monthlyCents?: number }[]
  /** New lines: a second job, a cancelled bill, a side business starting in a given month... */
  added: { label: string; kind: 'income' | 'expense'; irregular?: boolean; monthlyCents: number; fromIndex: number; toIndex: number | null }[]
  oneTime: OneTime[]
  months: number
}

export const emptyWhatIf = (base: 'current' | 'plan' = 'plan', months = 24): WhatIf => ({ base, incomePct: 0, spendPct: 0, extraDebtCents: 0, lines: [], added: [], oneTime: [], months })

/** Applies the person's edits to a base forecast input. The base input is not changed. */
export function applyWhatIf(base: ForecastInput, w: WhatIf): ForecastInput {
  const line = (id: string) => w.lines.find((l) => l.id === id)
  const incScale = 1 + w.incomePct / 100
  const spendScale = 1 + w.spendPct / 100
  const income: IncomeStream[] = base.income
    .filter((s) => line(s.id)?.enabled !== false)
    .map((s) => {
      const set = line(s.id)?.monthlyCents
      const ratio = set !== undefined && s.monthlyCents > 0 ? set / s.monthlyCents : 1
      const f = incScale * ratio
      return { ...s, monthlyCents: Math.round((set ?? s.monthlyCents) * incScale), lowCents: Math.round(s.lowCents * f), highCents: Math.round(s.highCents * f) }
    })
  for (const [n, a] of w.added.entries()) {
    if (a.kind !== 'income') continue
    const m = Math.round(a.monthlyCents * incScale)
    income.push({ id: `added-income-${n}`, label: a.label, kind: a.irregular ? 'irregular' : 'regular', monthlyCents: m, lowCents: a.irregular ? Math.round(m * 0.4) : m, highCents: a.irregular ? Math.round(m * 1.6) : m, fromIndex: a.fromIndex, toIndex: a.toIndex })
  }
  const expenses: ExpenseLine[] = base.expenses
    .filter((e) => line(e.id)?.enabled !== false)
    .map((e) => {
      const set = line(e.id)?.monthlyCents
      const v = set ?? e.monthlyCents
      return { ...e, monthlyCents: Math.round(e.kind === 'everyday' ? v * spendScale : v) }
    })
  for (const [n, a] of w.added.entries()) {
    if (a.kind === 'expense') expenses.push({ id: `added-expense-${n}`, label: a.label, kind: 'bill', monthlyCents: a.monthlyCents, fromIndex: a.fromIndex, toIndex: a.toIndex })
  }
  // extra money for debts: "minimum only" has no budget to add to, so it becomes "minimums plus the extra, highest interest first"
  let strategy = base.strategy
  let debtBudget = base.debtBudgetCents
  const extra = Math.max(0, w.extraDebtCents)
  if (extra > 0) {
    if (strategy === 'minimum') { strategy = 'avalanche'; debtBudget = base.debts.reduce((a, d) => a + Math.min(d.balanceCents, d.minPaymentCents), 0) }
    debtBudget += extra
  }
  return { ...base, months: w.months, income, expenses, strategy, debtBudgetCents: debtBudget, oneTime: [...(base.oneTime ?? []), ...w.oneTime] }
}

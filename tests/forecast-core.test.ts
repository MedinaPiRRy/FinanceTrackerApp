import { describe, it, expect } from 'vitest'
import { planPayoff, stepDebts, defaultBudget, defaultMinPayment, type PlanDebt } from '../src/core/debtPlan'
import { projectForecast, applyWhatIf, emptyWhatIf, type ForecastInput } from '../src/core/forecast'

const debt = (id: string, balanceCents: number, aprBps: number, minPaymentCents: number): PlanDebt => ({ id, label: id, balanceCents, aprBps, minPaymentCents })

describe('planPayoff', () => {
  it('a debt with no interest takes balance / payment months and costs nothing extra', () => {
    const r = planPayoff([debt('loan', 120000, 0, 10000)], { strategy: 'avalanche', monthlyBudgetCents: 10000, startMonth: '2026-11' })
    expect(r).toMatchObject({ months: 12, debtFreeMonth: '2027-10', totalInterestCents: 0, totalPaidCents: 120000 })
    expect(r.order).toEqual([{ id: 'loan', label: 'loan', paidOffMonth: '2027-10' }])
  })

  it('charges interest monthly on the balance carried in, then takes the payment', () => {
    const r = planPayoff([debt('card', 120000, 1200, 20000)], { strategy: 'avalanche', monthlyBudgetCents: 20000, startMonth: '2026-11' })
    expect(r.schedule[0]).toMatchObject({ interestCents: 1200, paidCents: 20000, balanceCents: 101200 }) // 12% a year = 1% a month = $12.00
    expect(r.schedule.at(-1)!.balanceCents).toBe(0)
    expect(r.totalPaidCents).toBe(120000 + r.totalInterestCents) // every dollar paid is either principal or interest
  })

  it('avalanche pays the highest rate first, snowball the smallest balance first, and avalanche never costs more interest', () => {
    const debts = [debt('big-expensive', 100000, 2500, 2500), debt('small-cheap', 50000, 500, 2500)]
    const av = planPayoff(debts, { strategy: 'avalanche', monthlyBudgetCents: 20000, startMonth: '2026-11' })
    const sn = planPayoff(debts, { strategy: 'snowball', monthlyBudgetCents: 20000, startMonth: '2026-11' })
    expect(av.order.map((o) => o.id)).toEqual(['big-expensive', 'small-cheap'])
    expect(sn.order.map((o) => o.id)).toEqual(['small-cheap', 'big-expensive'])
    expect(av.totalInterestCents).toBeLessThanOrEqual(sn.totalInterestCents)
    // the freed-up minimum rolls over, so the total paid each month stays at the budget until the last months
    expect(av.schedule[0]!.paidCents).toBe(20000)
    expect(av.schedule[1]!.paidCents).toBe(20000)
  })

  it('"minimum" pays only the minimums and does not roll freed amounts over, so it takes longer and costs more', () => {
    const debts = [debt('a', 100000, 2000, 5000), debt('b', 30000, 2000, 5000)]
    const min = planPayoff(debts, { strategy: 'minimum', monthlyBudgetCents: 999999, startMonth: '2026-11' })
    const av = planPayoff(debts, { strategy: 'avalanche', monthlyBudgetCents: 10000, startMonth: '2026-11' })
    expect(min.monthlyBudgetCents).toBe(10000) // the budget given is ignored
    expect(min.months!).toBeGreaterThan(av.months!)
    expect(min.totalInterestCents).toBeGreaterThan(av.totalInterestCents)
  })

  it('warns instead of looping for ever when payments do not cover the interest', () => {
    const r = planPayoff([debt('trap', 1_000_000, 2400, 1000)], { strategy: 'minimum', monthlyBudgetCents: 0, startMonth: '2026-11' })
    expect(r.months).toBeNull()
    expect(r.debtFreeMonth).toBeNull()
    expect(r.warnings.join(' ')).toMatch(/would not be paid off/)
    expect(r.schedule.length).toBeLessThanOrEqual(120)
  })

  it('raises a budget that is below the minimums, and says so', () => {
    const r = planPayoff([debt('a', 100000, 0, 5000), debt('b', 100000, 0, 5000)], { strategy: 'avalanche', monthlyBudgetCents: 3000, startMonth: '2026-11' })
    expect(r.monthlyBudgetCents).toBe(10000)
    expect(r.warnings[0]).toMatch(/below the minimum/)
  })

  it('never pays more than is owed and ignores debts already at zero', () => {
    const r = stepDebts([{ id: 'a', balanceCents: 3000, aprBps: 0, minPaymentCents: 5000 }, { id: 'z', balanceCents: 0, aprBps: 0, minPaymentCents: 5000 }], 100000, 'avalanche')
    expect(r).toEqual([{ id: 'a', paidCents: 3000, interestCents: 0, balanceCents: 0 }, { id: 'z', paidCents: 0, interestCents: 0, balanceCents: 0 }])
  })

  it('defaults: card minimum is max($25, 3%), a loan is spread over three years, and the budget is the minimums or 60% of the surplus', () => {
    expect(defaultMinPayment(100000, 'card')).toBe(3000)
    expect(defaultMinPayment(40000, 'card')).toBe(2500)
    expect(defaultMinPayment(1500, 'card')).toBe(1500) // never more than is owed
    expect(defaultMinPayment(360000, 'loan')).toBe(10000)
    const ds = [debt('a', 500000, 1999, 15000)]
    expect(defaultBudget(ds, null)).toBe(15000)
    expect(defaultBudget(ds, -5000)).toBe(15000)
    expect(defaultBudget(ds, 100000)).toBe(60000)
    expect(defaultBudget(ds, 5_000_000)).toBe(500000) // never more than is owed
    expect(defaultBudget(ds, 10000)).toBe(15000) // 60% of a small surplus is below the minimum
  })
})

const base = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  startMonth: '2026-11', months: 12, startCashCents: 100000, startInvestmentsCents: 0, debts: [], strategy: 'minimum', debtBudgetCents: 0,
  income: [{ id: 'pay', label: 'Pay', kind: 'regular', monthlyCents: 300000, lowCents: 300000, highCents: 300000 }],
  expenses: [{ id: 'rent', label: 'Rent', kind: 'bill', monthlyCents: 150000 }, { id: 'food', label: 'Everyday', kind: 'everyday', monthlyCents: 100000 }],
  goals: [], ...over
})

describe('projectForecast', () => {
  it('adds income minus spending to cash every month', () => {
    const r = projectForecast(base()).expected
    expect(r.months).toHaveLength(12)
    expect(r.months[0]).toMatchObject({ month: '2026-11', incomeCents: 300000, expenseCents: 250000, cashCents: 150000 })
    expect(r.months[11]).toMatchObject({ month: '2027-10', cashCents: 100000 + 12 * 50000 })
    expect(r.firstShortfall).toBeNull()
  })

  it('finds the first month cash goes below zero and the lowest point', () => {
    const r = projectForecast(base({ startCashCents: 20000, expenses: [{ id: 'x', label: 'Spending', kind: 'everyday', monthlyCents: 340000 }] })).expected
    expect(r.months[0]!.cashCents).toBe(-20000)
    expect(r.firstShortfall).toBe('2026-11')
    expect(r.lowestCash).toEqual({ month: '2027-10', cents: 20000 - 12 * 40000 })
  })

  it('irregular income gives a range: poor months, expected, good months. Regular income does not', () => {
    const r = projectForecast(base({ income: [
      { id: 'pay', label: 'Pay', kind: 'regular', monthlyCents: 300000, lowCents: 300000, highCents: 300000 },
      { id: 'gig', label: 'Freelance', kind: 'irregular', monthlyCents: 50000, lowCents: 0, highCents: 120000 }
    ] }))
    expect(r.low.months[0]!.incomeCents).toBe(300000)
    expect(r.expected.months[0]!.incomeCents).toBe(350000)
    expect(r.high.months[0]!.incomeCents).toBe(420000)
    expect(r.low.months[11]!.cashCents).toBeLessThan(r.expected.months[11]!.cashCents)
    expect(r.expected.months[11]!.cashCents).toBeLessThan(r.high.months[11]!.cashCents)
  })

  it('goal contributions leave spendable cash but not net worth, and stop when the goal is reached', () => {
    const none = projectForecast(base()).expected
    const r = projectForecast(base({ goals: [{ id: 'g', label: 'Trip', monthlyCents: 20000, remainingCents: 50000 }] })).expected
    expect(r.months.slice(0, 4).map((m) => m.goalCents)).toEqual([20000, 20000, 10000, 0])
    expect(r.months[3]!.cashCents).toBe(none.months[3]!.cashCents - 50000)
    expect(r.months[3]!.setAsideCents).toBe(50000)
    expect(r.months[11]!.netWorthCents).toBe(none.months[11]!.netWorthCents) // set aside is still yours
    expect(r.goalDone).toEqual([{ id: 'g', label: 'Trip', month: '2027-01' }])
  })

  it('debts accrue interest and are paid from cash; paying them off shows the month, and the total interest', () => {
    const r = projectForecast(base({ debts: [debt('card', 120000, 1200, 20000)], strategy: 'avalanche', debtBudgetCents: 20000 })).expected
    expect(r.months[0]).toMatchObject({ interestCents: 1200, debtPaidCents: 20000, debtCents: 101200, cashCents: 100000 + 50000 - 20000 })
    expect(r.debtFreeMonth).toBe('2027-05')
    expect(r.months.at(-1)!.debtCents).toBe(0)
    expect(r.totalInterestCents).toBeGreaterThan(0)
    // paying a debt moves money, it does not lose it: net worth changes only by the interest
    expect(r.months[0]!.netWorthCents - (100000 + 50000 - 120000)).toBe(-1200)
  })

  it('applies one-off events in the month they fall', () => {
    const r = projectForecast(base({ oneTime: [{ label: 'Car repair', index: 2, cents: -80000 }, { label: 'Tax refund', index: 4, cents: 120000 }] })).expected
    expect(r.months[2]!.expenseCents).toBe(250000 + 80000)
    expect(r.months[4]!.incomeCents).toBe(300000 + 120000)
  })

  it('lines can start later and end earlier', () => {
    const r = projectForecast(base({ income: [{ id: 'job', label: 'Second job', kind: 'regular', monthlyCents: 60000, lowCents: 60000, highCents: 60000, fromIndex: 3, toIndex: 5 }] })).expected
    expect(r.months.map((m) => m.incomeCents)).toEqual([0, 0, 0, 60000, 60000, 60000, 0, 0, 0, 0, 0, 0])
  })
})

describe('applyWhatIf', () => {
  it('scales income and everyday spending, leaves bills alone, and does not change the base', () => {
    const b = base()
    const snapshot = JSON.stringify(b)
    const w = { ...emptyWhatIf('current', 12), incomePct: 10, spendPct: -20 }
    const r = projectForecast(applyWhatIf(b, w)).expected
    expect(r.months[0]).toMatchObject({ incomeCents: 330000, expenseCents: 150000 + 80000 })
    expect(JSON.stringify(b)).toBe(snapshot)
  })

  it('switches a line off or sets a new amount (cancelling a bill, a raise)', () => {
    const w = { ...emptyWhatIf('current', 12), lines: [{ id: 'rent', enabled: false }, { id: 'pay', monthlyCents: 330000 }] }
    const r = projectForecast(applyWhatIf(base(), w)).expected
    expect(r.months[0]).toMatchObject({ incomeCents: 330000, expenseCents: 100000 })
  })

  it('adds a second job or a new bill from a chosen month, and irregular side income gets a range', () => {
    const w = { ...emptyWhatIf('current', 12), added: [
      { label: 'Second job', kind: 'income' as const, monthlyCents: 60000, fromIndex: 2, toIndex: null },
      { label: 'Etsy shop', kind: 'income' as const, irregular: true, monthlyCents: 40000, fromIndex: 0, toIndex: null },
      { label: 'Gym', kind: 'expense' as const, monthlyCents: 5000, fromIndex: 1, toIndex: 3 }
    ] }
    const r = projectForecast(applyWhatIf(base(), w))
    expect(r.expected.months[0]!.incomeCents).toBe(340000)
    expect(r.expected.months[2]!.incomeCents).toBe(400000)
    expect(r.expected.months[1]!.expenseCents).toBe(255000)
    expect(r.expected.months[4]!.expenseCents).toBe(250000)
    expect(r.low.months[0]!.incomeCents).toBeLessThan(r.high.months[0]!.incomeCents)
  })

  it('extra debt money turns "minimums only" into "minimums plus the extra, highest rate first"', () => {
    const b = base({ debts: [debt('card', 300000, 1999, 9000)], strategy: 'minimum' })
    const slow = projectForecast(b).expected
    const fast = projectForecast(applyWhatIf(b, { ...emptyWhatIf('current', 12), extraDebtCents: 30000 })).expected
    expect(fast.months[0]!.debtPaidCents).toBe(39000)
    expect(fast.totalInterestCents).toBeLessThan(slow.totalInterestCents)
    expect(fast.months[11]!.debtCents).toBeLessThan(slow.months[11]!.debtCents)
  })
})

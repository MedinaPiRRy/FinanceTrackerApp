import { describe, it, expect } from 'vitest'
import { generateInsights, budgetInsights, goalInsights, type InsightTxn } from '../src/core/insights'
import { computeGoal } from '../src/core/goals'
import type { MonthSummary } from '../src/core/summary'

const ms = (month: string, income: number, expense: number, byCategory: Record<string, number> = {}): MonthSummary => ({
  month, incomeCents: income, expenseCents: expense, netCents: income - expense, savingsRate: income > 0 ? (income - expense) / income : null, byCategory
})

describe('insights', () => {
  it('names the largest category and its share', () => {
    const series = [ms('2026-09', 300000, 100000, { Housing: 60000, Dining: 40000 })]
    const i = generateInsights({ month: '2026-09', series, txns: [], recurringMonthlyCents: 0 })
    expect(i[0]!.title).toContain('Housing')
    expect(i[0]!.detail).toContain('60%')
  })

  it('flags a category jump against last month, but ignores tiny dollar changes', () => {
    const series = [ms('2026-08', 300000, 50000, { Dining: 20000, Fuel: 1000 }), ms('2026-09', 300000, 60000, { Dining: 25600, Fuel: 2000 })]
    const titles = generateInsights({ month: '2026-09', series, txns: [], recurringMonthlyCents: 0 }).map((x) => x.title)
    expect(titles.some((t) => t.includes('Dining spending rose 28%'))).toBe(true)
    expect(titles.some((t) => t.includes('Fuel'))).toBe(false) // +100% but only $10
  })

  it('detects consecutive monthly increases', () => {
    const series = [ms('2026-06', 1, 100000), ms('2026-07', 1, 110000), ms('2026-08', 1, 120000), ms('2026-09', 1, 130000)]
    const t = generateInsights({ month: '2026-09', series, txns: [], recurringMonthlyCents: 0 }).find((x) => x.title.includes('consecutive'))
    expect(t?.title).toContain('3 consecutive')
  })

  it('does not call a normal month an anomaly and does call an outlier one', () => {
    const base = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].map((m, i) => ms(m, 300000, 200000 + (i % 2) * 10000))
    const normal = generateInsights({ month: '2026-06', series: [...base, ms('2026-06', 300000, 205000)], txns: [], recurringMonthlyCents: 0 })
    expect(normal.some((x) => x.type === 'anomaly')).toBe(false)
    const high = generateInsights({ month: '2026-06', series: [...base, ms('2026-06', 300000, 400000)], txns: [], recurringMonthlyCents: 0 })
    expect(high.some((x) => x.type === 'anomaly' && x.title.includes('unusually high'))).toBe(true)
  })

  it('flags an unusually large single purchase only with enough history', () => {
    const hist: InsightTxn[] = Array.from({ length: 6 }, (_, i) => ({ date: `2026-0${i + 1}-10`, amountCents: -2000, kind: 'expense', category: 'Shopping', description: 'Shirt' }))
    const big: InsightTxn = { date: '2026-09-03', amountCents: -35000, kind: 'expense', category: 'Shopping', description: 'Handbag' }
    const series = [ms('2026-09', 1, 35000, { Shopping: 35000 })]
    const out = generateInsights({ month: '2026-09', series, txns: [...hist, big], recurringMonthlyCents: 0 })
    expect(out.some((x) => x.title.includes('Handbag'))).toBe(true)
    const few = generateInsights({ month: '2026-09', series, txns: [big], recurringMonthlyCents: 0 })
    expect(few.some((x) => x.title.includes('Handbag'))).toBe(false)
  })

  it('computes recurring share of average income and warns when spending beats income', () => {
    const series = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((m) => ms(m, 200000, 250000, { Dining: 250000 }))
    const out = generateInsights({ month: '2026-09', series, txns: [], recurringMonthlyCents: 50000 })
    expect(out.find((x) => x.title.includes('Recurring bills'))?.title).toContain('25%')
    expect(out.find((x) => x.type === 'recommendation')).toBeTruthy()
  })

  it('returns nothing for a month without data', () => {
    expect(generateInsights({ month: '2026-12', series: [ms('2026-09', 1, 1)], txns: [], recurringMonthlyCents: 0 })).toEqual([])
  })
})

describe('budget and goal insights', () => {
  it('says how far over, how close, and how far below budget', () => {
    const out = budgetInsights([
      { name: 'Dining', budgetCents: 25000, spentCents: 31000 },
      { name: 'Groceries', budgetCents: 50000, spentCents: 45000 },
      { name: 'Entertainment', budgetCents: 30000, spentCents: 17500 },
      { name: 'Fuel', budgetCents: 20000, spentCents: 2000 },
      { name: 'Fees', budgetCents: 0, spentCents: 500 }
    ]).map((i) => i.title)
    expect(out).toContain('Dining is $60.00 over budget')
    expect(out).toContain('Fees is $5.00 over budget')
    expect(out).toContain('Groceries is at 90% of its budget')
    expect(out).toContain('You are $125.00 below your Entertainment budget')
  })
  it('warns when the month-end projection will exceed a budget that is still within limit', () => {
    const out = budgetInsights([{ name: 'Dining', budgetCents: 25000, spentCents: 12000, projectedCents: 31000 }])
    expect(out[0]!.title).toBe('Dining is on pace to go over budget this month')
  })
  it('describes goal pace without overpromising', () => {
    const today = '2026-10-02'
    const onTrack = computeGoal({ kind: 'manual', targetCents: 120000, achievedCents: 0, deadline: '2027-09-30', plannedMonthlyCents: 10000, today })
    const behind = computeGoal({ kind: 'manual', targetCents: 120000, achievedCents: 0, deadline: '2027-03-31', plannedMonthlyCents: 10000, today })
    const none = computeGoal({ kind: 'account', targetCents: 120000, achievedCents: null, deadline: null, plannedMonthlyCents: 10000, today })
    const out = goalInsights([
      { name: 'Trip', deadline: '2027-09-30', plannedMonthlyCents: 10000, progress: onTrack },
      { name: 'Car', deadline: '2027-03-31', plannedMonthlyCents: 10000, progress: behind },
      { name: 'Home', deadline: null, plannedMonthlyCents: 10000, progress: none }
    ])
    expect(out[0]!.title).toContain('on pace to reach "Trip" by September 2027')
    expect(out[1]!.title).toContain('after your deadline')
    expect(out[1]!.detail).toContain('$') // says what would be needed
    expect(out[2]!.title).toContain('Enter the current value')
  })
})

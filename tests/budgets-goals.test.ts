import { describe, it, expect } from 'vitest'
import { budgetStatus, projectMonthEnd, allocateSpending, daysInMonth, monthEnd } from '../src/core/budgets'
import { computeGoal, monthsUntil } from '../src/core/goals'

describe('budget status', () => {
  it('shows what is left and flags near/over limits', () => {
    expect(budgetStatus(50000, 42000)).toMatchObject({ remainingCents: 8000, state: 'ok' })
    expect(budgetStatus(25000, 21250)).toMatchObject({ state: 'near' }) // exactly 85%
    expect(budgetStatus(25000, 31000)).toMatchObject({ remainingCents: -6000, state: 'over' })
    expect(budgetStatus(25000, 25000)).toMatchObject({ state: 'near' }) // spending exactly the limit is not over
    expect(budgetStatus(0, 100)).toMatchObject({ state: 'over', ratio: null }) // nothing planned
    expect(budgetStatus(0, 0)).toMatchObject({ state: 'ok' })
  })
  it('refunds can bring a budget back under', () => {
    expect(budgetStatus(10000, 4000).remainingCents).toBe(6000)
  })
  it('projects month-end spending only after a week of data', () => {
    expect(projectMonthEnd(30000, 3, '2026-10')).toBeNull()
    expect(projectMonthEnd(31000, 10, '2026-10')).toBe(96100) // 31 days
    expect(projectMonthEnd(31000, 31, '2026-10')).toBe(31000)
    expect(daysInMonth('2026-02')).toBe(28)
    expect(daysInMonth('2028-02')).toBe(29)
    expect(monthEnd('2026-09')).toBe('2026-09-30')
  })
  it('allocates category spending to budgets and lists the rest as unbudgeted', () => {
    const spend = new Map([[1, 10000], [2, 5000], [3, 7000], [4, 0]])
    const r = allocateSpending([{ id: 1, name: 'Food', monthlyCents: 20000, categoryIds: [1, 2] }, { id: 2, name: 'Fun', monthlyCents: 3000, categoryIds: [] }], spend)
    expect(r.lines.map((l) => l.spentCents)).toEqual([15000, 0])
    expect(r.unbudgeted).toEqual([{ categoryId: 3, spentCents: 7000 }]) // zero-spend categories are omitted
  })
})

describe('goal progress', () => {
  const today = '2026-10-02'
  it('counts months to a deadline inclusively and never below one', () => {
    expect(monthsUntil('2026-10-31', today)).toBe(1)
    expect(monthsUntil('2027-09-30', today)).toBe(12)
    expect(monthsUntil('2026-01-01', today)).toBe(1)
  })
  it('savings goal: progress, required monthly amount and estimated completion', () => {
    const g = computeGoal({ kind: 'manual', targetCents: 1_200_000, achievedCents: 300_000, deadline: '2027-09-30', plannedMonthlyCents: 100_000, today })
    expect(g.progress).toBeCloseTo(0.25)
    expect(g.remainingCents).toBe(900_000)
    expect(g.requiredMonthlyCents).toBe(75_000) // 9000 / 12 months
    expect(g.monthsToGo).toBe(9)
    expect(g.estimatedMonth).toBe('2027-06') // 9 payments: Oct 2026 .. Jun 2027
    expect(g.status).toBe('on_track')
  })
  it('is behind when the planned amount finishes after the deadline, or nothing is planned', () => {
    expect(computeGoal({ kind: 'manual', targetCents: 1_200_000, achievedCents: 0, deadline: '2027-09-30', plannedMonthlyCents: 50_000, today }).status).toBe('behind')
    expect(computeGoal({ kind: 'manual', targetCents: 1_200_000, achievedCents: 0, deadline: '2027-09-30', plannedMonthlyCents: null, today }).status).toBe('behind')
  })
  it('without a deadline there is no required amount but an estimate is given if a monthly plan exists', () => {
    const g = computeGoal({ kind: 'manual', targetCents: 5_000_000, achievedCents: 363_400, deadline: null, plannedMonthlyCents: 40_000, today })
    expect(g.requiredMonthlyCents).toBeNull()
    expect(g.status).toBe('no_deadline')
    expect(g.monthsToGo).toBe(116) // 46,366 / 400 = 115.9, rounded up
    expect(g.estimatedMonth).toBe('2036-05') // 116 payments starting this month
  })
  it('a minimum target ("at least $60,000") can be beaten: progress above 100%, achieved', () => {
    const g = computeGoal({ kind: 'account', targetCents: 6_000_000, achievedCents: 6_500_000, deadline: null, plannedMonthlyCents: 80_000, today })
    expect(g.status).toBe('achieved')
    expect(g.progress).toBeGreaterThan(1)
    expect(g.remainingCents).toBe(0)
  })
  it('an account that was never valued has no progress rather than a fake zero', () => {
    const g = computeGoal({ kind: 'account', targetCents: 6_000_000, achievedCents: null, deadline: null, plannedMonthlyCents: 80_000, today })
    expect(g.status).toBe('no_value')
    expect(g.estimatedMonth).toBeNull()
  })
  it('overdue goals say so and require the whole remainder', () => {
    const g = computeGoal({ kind: 'manual', targetCents: 100_000, achievedCents: 40_000, deadline: '2026-06-30', plannedMonthlyCents: 10_000, today })
    expect(g.status).toBe('overdue')
    expect(g.requiredMonthlyCents).toBe(60_000)
  })
  it('debt payoff: progress is paid-off / starting amount, remaining is what is owed now', () => {
    const g = computeGoal({ kind: 'debt', targetCents: 1_417_819, achievedCents: 200_000, owedCents: 1_217_819, deadline: null, plannedMonthlyCents: 25_000, today })
    expect(g.progress).toBeCloseTo(0.141, 2)
    expect(g.remainingCents).toBe(1_217_819)
    expect(g.monthsToGo).toBe(49)
    expect(computeGoal({ kind: 'debt', targetCents: 100_000, achievedCents: 100_000, owedCents: 0, deadline: null, plannedMonthlyCents: null, today }).status).toBe('achieved')
  })
  it('debt that grew shows zero progress and the true amount owed', () => {
    const g = computeGoal({ kind: 'debt', targetCents: 100_000, achievedCents: 0, owedCents: 130_000, deadline: null, plannedMonthlyCents: null, today })
    expect(g.progress).toBe(0)
    expect(g.remainingCents).toBe(130_000)
  })
})

import { describe, it, expect } from 'vitest'
import { toCents, parseMoneyToCents, formatCents } from '../src/core/money'
import { addDays, addMonths, daysBetween, monthKey, monthRange } from '../src/core/dates'
import { monthlyCostCents, annualCostCents } from '../src/core/recurring'
import { summarizeMonth, type SummaryTxn } from '../src/core/summary'

describe('money', () => {
  it('converts floats to exact cents', () => {
    expect(toCents(14.68)).toBe(1468)
    expect(toCents(0.1 + 0.2)).toBe(30)
    expect(toCents(-8.82)).toBe(-882)
    expect(toCents(1.005)).toBe(101) // two-decimal inputs only; documented behaviour
  })
  it('parses statement-style strings', () => {
    expect(parseMoneyToCents('1,234.50')).toBe(123450)
    expect(parseMoneyToCents('(12.00)')).toBe(-1200)
    expect(parseMoneyToCents('-$5')).toBe(-500)
    expect(parseMoneyToCents('')).toBeNull()
    expect(parseMoneyToCents('abc')).toBeNull()
  })
  it('formats CAD', () => {
    expect(formatCents(123456)).toBe('$1,234.56')
    expect(formatCents(-500)).toBe('-$5.00')
    expect(formatCents(500, { sign: true })).toBe('+$5.00')
  })
})

describe('dates', () => {
  it('does ISO date arithmetic without timezone drift', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(daysBetween('2026-09-01', '2026-09-25')).toBe(24)
    expect(monthKey('2026-09-25')).toBe('2026-09')
    expect(addMonths('2026-11', 3)).toBe('2027-02')
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })
  it('rejects non-ISO input', () => {
    expect(() => addDays('09/25/2026', 1)).toThrow()
  })
})

describe('recurring costs', () => {
  it('uses exact fractions, not the rounded 2.166667 of the spreadsheets', () => {
    expect(monthlyCostCents(66057, 'biweekly')).toBe(143124) // 660.57 * 26/12 = 1431.235 -> 1431.24
    expect(monthlyCostCents(3954, 'quarterly')).toBe(1318)
    expect(monthlyCostCents(10000, 'monthly')).toBe(10000)
    expect(annualCostCents(10000, 'monthly')).toBe(120000)
    expect(monthlyCostCents(500, 'irregular')).toBe(0)
  })
})

describe('monthly summary', () => {
  const t = (date: string, amountCents: number, kind: SummaryTxn['kind'], category: string | null = null): SummaryTxn => ({ date, amountCents, kind, category })
  const txns: SummaryTxn[] = [
    t('2026-09-01', 200000, 'income', 'Pay'),
    t('2026-09-02', -5000, 'expense', 'Dining'),
    t('2026-09-03', -3000, 'expense', 'Dining'),
    t('2026-09-04', 1000, 'refund', 'Dining'), // refund reduces spending
    t('2026-09-05', -50000, 'transfer'), // card payment: never spending
    t('2026-09-06', 12345, 'unclassified'), // never counted until reviewed
    t('2026-10-01', -9999, 'expense', 'Other')
  ]
  it('counts income, spending net of refunds, and ignores transfers/unclassified', () => {
    const s = summarizeMonth(txns, '2026-09')
    expect(s.incomeCents).toBe(200000)
    expect(s.expenseCents).toBe(7000)
    expect(s.netCents).toBe(193000)
    expect(s.savingsRate).toBeCloseTo(0.965)
    expect(s.byCategory).toEqual({ Dining: 7000 })
  })
  it('has a null savings rate when there is no income', () => {
    expect(summarizeMonth(txns, '2026-10').savingsRate).toBeNull()
  })
})

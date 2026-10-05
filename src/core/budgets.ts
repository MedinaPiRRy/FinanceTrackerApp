import { addDays } from './dates'

export type BudgetState = 'ok' | 'near' | 'over'

export interface BudgetStatus {
  budgetCents: number
  spentCents: number
  /** Positive = left to spend, negative = overspent. */
  remainingCents: number
  /** spent / budget; null when the budget is $0 (nothing was planned). */
  ratio: number | null
  state: BudgetState
}

/** 'near' starts at 85% of the limit. A $0 budget is 'over' as soon as anything is spent. */
export const NEAR_THRESHOLD = 0.85

export function budgetStatus(budgetCents: number, spentCents: number): BudgetStatus {
  const remaining = budgetCents - spentCents
  const ratio = budgetCents > 0 ? spentCents / budgetCents : null
  let state: BudgetState = 'ok'
  if (spentCents > budgetCents) state = 'over'
  else if (ratio !== null && ratio >= NEAR_THRESHOLD) state = 'near'
  return { budgetCents, spentCents, remainingCents: remaining, ratio, state }
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * Straight-line projection of month-end spending from spending so far. Only meaningful part-way through a
 * month (it needs at least 7 days of data, otherwise null so early noise is not presented as a forecast).
 */
export function projectMonthEnd(spentCents: number, dayOfMonth: number, month: string): number | null {
  if (dayOfMonth < 7) return null
  const total = daysInMonth(month)
  if (dayOfMonth >= total) return spentCents
  return Math.round((spentCents / dayOfMonth) * total)
}

/** Sums spending (expenses minus refunds) per budget from per-category totals. Categories in no budget are returned separately. */
export function allocateSpending(
  budgets: { id: number; name: string; monthlyCents: number; categoryIds: number[] }[],
  spendByCategory: Map<number, number>
): { lines: { id: number; name: string; monthlyCents: number; spentCents: number }[]; unbudgeted: { categoryId: number; spentCents: number }[] } {
  const covered = new Set<number>()
  const lines = budgets.map((b) => {
    let spent = 0
    for (const c of b.categoryIds) {
      covered.add(c)
      spent += spendByCategory.get(c) ?? 0
    }
    return { id: b.id, name: b.name, monthlyCents: b.monthlyCents, spentCents: spent }
  })
  const unbudgeted = [...spendByCategory.entries()].filter(([c, v]) => !covered.has(c) && v !== 0).map(([categoryId, spentCents]) => ({ categoryId, spentCents })).sort((a, b) => b.spentCents - a.spentCents)
  return { lines, unbudgeted }
}

/** First and last ISO date of a month. */
export const monthStart = (month: string) => `${month}-01`
export const monthEnd = (month: string) => addDays(`${month}-01`, daysInMonth(month) - 1)

export interface SuggestionInput { key: string; name: string; monthlyCents: number[] }
export interface BudgetSuggestion { key: string; name: string; averageCents: number; suggestedCents: number; highestCents: number; monthsWithSpending: number }

/** Spending below this per month is not worth a budget line of its own. */
export const MIN_SUGGEST_AVERAGE_CENTS = 1000
/** Suggested limits are rounded up to this step so they are tidy numbers. */
export const SUGGEST_STEP_CENTS = 500

/**
 * Turns "what was spent per month" into suggested monthly limits. The suggestion is the average over the months
 * considered, rounded UP to the next $5, so an ordinary month does not start out over budget. Months are counted
 * as given (a month with no spending in a category counts as zero), and categories averaging under $10 a month are left out.
 */
export function suggestLimits(items: SuggestionInput[]): BudgetSuggestion[] {
  const out: BudgetSuggestion[] = []
  for (const it of items) {
    const n = it.monthlyCents.length
    if (n === 0) continue
    const total = it.monthlyCents.reduce((a, c) => a + c, 0)
    const average = Math.round(total / n)
    if (average < MIN_SUGGEST_AVERAGE_CENTS) continue
    out.push({
      key: it.key, name: it.name, averageCents: average,
      suggestedCents: Math.ceil(average / SUGGEST_STEP_CENTS) * SUGGEST_STEP_CENTS,
      highestCents: Math.max(...it.monthlyCents), monthsWithSpending: it.monthlyCents.filter((c) => c > 0).length
    })
  }
  return out.sort((a, b) => b.averageCents - a.averageCents || a.name.localeCompare(b.name))
}

/** The up-to-three complete months before the month of `today`, oldest first (e.g. today 2026-10-04 -> 2026-07, 2026-08, 2026-09). */
export function lastCompleteMonths(today: string, count = 3): string[] {
  const [y, m] = today.split('-').map(Number) as [number, number]
  const out: string[] = []
  for (let i = count; i >= 1; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

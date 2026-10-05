import type { Db } from './open'
import { getDashboard, listRecurring, type Dashboard } from './queries'
import { budgetReport, type BudgetReport } from './budgets'
import { listGoals, type GoalView } from './goals'
import { monthEnd, monthStart } from '../core/budgets'
import { keyMatches } from '../core/categorize'
import { normalizeKey } from '../core/normalize'
import type { Insight } from '../core/insights'
import type { MonthSummary } from '../core/summary'

export interface RecurringCheck {
  name: string
  expectedCents: number
  account: string | null
  status: 'paid' | 'not_seen'
  paidCents: number | null
  date: string | null
}

export interface MonthlyReview {
  month: string
  availableMonths: string[]
  summary: MonthSummary
  previous: MonthSummary | null
  categoryChanges: { name: string; cents: number; prevCents: number; deltaCents: number }[]
  topExpenses: Dashboard['largestExpenses']
  unusual: Insight[]
  budget: BudgetReport
  recurring: RecurringCheck[]
  goals: GoalView[]
  insights: Insight[]
  pending: { reviewCount: number; uncategorizedCount: number }
}

/**
 * Answers "how did this month go?". Everything is derived from recorded transactions, budgets and goals.
 * The recurring-bill check is best effort: a bill counts as paid if a transaction in the month matches its name
 * or matches its amount on the same account.
 */
export function getMonthlyReview(db: Db, profileId: number, month: string | undefined, today: string): MonthlyReview | null {
  const dash = getDashboard(db, profileId, month, today)
  if (!dash) return null
  const m = dash.month
  const prev = dash.previous
  const names = new Set([...Object.keys(dash.summary.byCategory), ...Object.keys(prev?.byCategory ?? {})])
  const categoryChanges = [...names]
    .map((name) => ({ name, cents: dash.summary.byCategory[name] ?? 0, prevCents: prev?.byCategory[name] ?? 0 }))
    .map((c) => ({ ...c, deltaCents: c.cents - c.prevCents }))
    .filter((c) => c.deltaCents !== 0)
    .sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents))
    .slice(0, 8)

  const top = db.prepare(`SELECT t.id, t.posted_date AS date, t.description, c.name AS category, -t.amount_cents AS cents FROM txn t LEFT JOIN category c ON c.id = t.category_id WHERE t.profile_id = ? AND t.kind = 'expense' AND t.posted_date BETWEEN ? AND ? ORDER BY t.amount_cents ASC LIMIT 10`).all(profileId, monthStart(m), monthEnd(m)) as Dashboard['largestExpenses']

  const monthTxns = db.prepare(`SELECT t.posted_date AS date, t.amount_cents AS cents, t.description, a.name AS account FROM txn t JOIN account a ON a.id = t.account_id WHERE t.profile_id = ? AND t.kind = 'expense' AND t.posted_date BETWEEN ? AND ?`).all(profileId, monthStart(m), monthEnd(m)) as { date: string; cents: number; description: string; account: string }[]
  const recurring: RecurringCheck[] = listRecurring(db, profileId)
    .filter((r) => r.direction === 'expense' && r.countsInBudget && r.status !== 'cancelled' && ['weekly', 'biweekly', 'semimonthly', 'monthly'].includes(r.frequency))
    .map((r) => {
      const key = normalizeKey(r.name)
      const hit = monthTxns.find((t) => {
        const k = normalizeKey(t.description)
        const nameMatch = keyMatches(k, key) || keyMatches(key, k)
        const amountMatch = Math.abs(-t.cents - r.amountCents) <= 50 && t.account === r.account
        return nameMatch || amountMatch
      })
      return { name: r.name, expectedCents: r.amountCents, account: r.account, status: hit ? ('paid' as const) : ('not_seen' as const), paidCents: hit ? -hit.cents : null, date: hit?.date ?? null }
    })

  const uncategorized = (db.prepare(`SELECT COUNT(*) n FROM txn WHERE profile_id = ? AND kind IN ('expense','income','refund') AND category_id IS NULL AND posted_date BETWEEN ? AND ?`).get(profileId, monthStart(m), monthEnd(m)) as { n: number }).n
  return {
    month: m,
    availableMonths: dash.availableMonths,
    summary: dash.summary,
    previous: prev,
    categoryChanges,
    topExpenses: top,
    unusual: dash.insights.filter((i) => i.type === 'anomaly'),
    budget: budgetReport(db, profileId, m, today),
    recurring,
    goals: listGoals(db, profileId, today),
    insights: dash.insights,
    pending: { reviewCount: dash.reviewCount, uncategorizedCount: uncategorized }
  }
}


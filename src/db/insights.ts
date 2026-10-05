// The Insights tab and the gentle banner: the same insights the dashboard shows, with evidence you can open.
import type { Db } from './open'
import { getDashboard, queryTxns, type TxnRow } from './queries'
import { budgetReport, type BudgetLine } from './budgets'
import { listGoals, type GoalView } from './goals'
import { monthEnd, monthStart } from '../core/budgets'
import type { Insight, InsightRef } from '../core/insights'

export interface InsightsView { month: string | null; availableMonths: string[]; insights: Insight[] }

export function insightsFor(db: Db, profileId: number, month: string | undefined, today: string): InsightsView {
  const d = getDashboard(db, profileId, month, today)
  if (!d) return { month: null, availableMonths: [], insights: [] }
  return { month: d.month, availableMonths: d.availableMonths, insights: d.insights }
}

export type Evidence =
  | { kind: 'transactions'; rows: TxnRow[]; total: number; sumCents: number }
  | { kind: 'budget'; line: BudgetLine }
  | { kind: 'goal'; goal: GoalView }
  | { kind: 'none' }

/** The data behind an insight: the transactions it is about, the budget line, or the goal. Read-only. */
export function insightEvidence(db: Db, profileId: number, ref: InsightRef, today: string): Evidence {
  const month = ref.month
  if (ref.page === 'transactions') {
    const cat = ref.category ? (db.prepare("SELECT id FROM category WHERE profile_id = ? AND name = ? AND kind = 'expense'").get(profileId, ref.category) as { id: number } | undefined) : undefined
    if (ref.category && !cat) return { kind: 'none' }
    const r = queryTxns(db, profileId, {
      categoryId: cat?.id, text: ref.text, from: month ? monthStart(month) : undefined, to: month ? monthEnd(month) : undefined,
      kind: ref.category ? 'expense' : undefined, sort: 'amount', dir: 'desc', limit: 8
    })
    return { kind: 'transactions', rows: r.rows, total: r.total, sumCents: r.sumCents }
  }
  if (ref.page === 'budget' && ref.budget) {
    const line = budgetReport(db, profileId, month ?? today.slice(0, 7), today).lines.find((l) => l.name === ref.budget)
    return line ? { kind: 'budget', line } : { kind: 'none' }
  }
  if (ref.page === 'goals' && ref.goal) {
    const goal = listGoals(db, profileId, today).find((g) => g.name === ref.goal)
    return goal ? { kind: 'goal', goal } : { kind: 'none' }
  }
  return { kind: 'none' }
}

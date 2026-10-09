import type { Db } from './open'
import { allocateSpending, budgetStatus, monthEnd, monthStart, projectMonthEnd, suggestLimits, lastCompleteMonths, type BudgetStatus, type BudgetSuggestion } from '../core/budgets'
import { monthKey } from '../core/dates'

export interface BudgetRow { id: number; name: string; monthlyCents: number; categoryIds: number[] }

export function listBudgets(db: Db, profileId: number): BudgetRow[] {
  const rows = db.prepare('SELECT id, name, monthly_cents AS monthlyCents FROM budget WHERE profile_id = ? ORDER BY id').all(profileId) as { id: number; name: string; monthlyCents: number }[]
  const cats = db.prepare('SELECT budget_id AS b, category_id AS c FROM budget_category WHERE budget_id IN (SELECT id FROM budget WHERE profile_id = ?)').all(profileId) as { b: number; c: number }[]
  return rows.map((r) => ({ ...r, categoryIds: cats.filter((x) => x.b === r.id).map((x) => x.c) }))
}

function checkCategories(db: Db, profileId: number, ids: number[], exceptBudget?: number) {
  for (const id of ids) {
    const c = db.prepare('SELECT profile_id p, kind, name FROM category WHERE id = ?').get(id) as { p: number; kind: string; name: string } | undefined
    if (!c || c.p !== profileId) throw new Error('That category belongs to someone else. Pick one of your own.')
    if (c.kind !== 'expense') throw new Error(`"${c.name}" is an income category; budgets cover spending`)
    const taken = db.prepare('SELECT b.name FROM budget_category bc JOIN budget b ON b.id = bc.budget_id WHERE bc.category_id = ? AND bc.budget_id IS NOT ?').get(id, exceptBudget ?? null) as { name: string } | undefined
    if (taken) throw new Error(`"${c.name}" is already in the "${taken.name}" budget`)
  }
}

export function createBudget(db: Db, profileId: number, name: string, monthlyCents: number, categoryIds: number[]): number {
  const clean = name.trim()
  if (!clean) throw new Error('Give the budget a name')
  if (!Number.isInteger(monthlyCents) || monthlyCents < 0) throw new Error('The monthly amount cannot be negative')
  if (db.prepare('SELECT 1 FROM budget WHERE profile_id = ? AND name = ? COLLATE NOCASE').get(profileId, clean)) throw new Error(`There is already a budget called "${clean}"`)
  return db.transaction(() => {
    checkCategories(db, profileId, categoryIds)
    const id = Number(db.prepare('INSERT INTO budget (profile_id, name, monthly_cents) VALUES (?,?,?)').run(profileId, clean, monthlyCents).lastInsertRowid)
    for (const c of categoryIds) db.prepare('INSERT INTO budget_category (budget_id, category_id) VALUES (?,?)').run(id, c)
    return id
  })()
}

function owned(db: Db, profileId: number, id: number) {
  if (!db.prepare('SELECT 1 FROM budget WHERE id = ? AND profile_id = ?').get(id, profileId)) throw new Error('That budget no longer exists. Reload the page.')
}

export function updateBudget(db: Db, profileId: number, id: number, patch: { name?: string; monthlyCents?: number; categoryIds?: number[] }): void {
  owned(db, profileId, id)
  db.transaction(() => {
    if (patch.name !== undefined) {
      const clean = patch.name.trim()
      if (!clean) throw new Error('Give the budget a name')
      if (db.prepare('SELECT 1 FROM budget WHERE profile_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(profileId, clean, id)) throw new Error(`There is already a budget called "${clean}"`)
      db.prepare('UPDATE budget SET name = ? WHERE id = ?').run(clean, id)
    }
    if (patch.monthlyCents !== undefined) {
      if (!Number.isInteger(patch.monthlyCents) || patch.monthlyCents < 0) throw new Error('The monthly amount cannot be negative')
      db.prepare('UPDATE budget SET monthly_cents = ? WHERE id = ?').run(patch.monthlyCents, id)
    }
    if (patch.categoryIds !== undefined) {
      checkCategories(db, profileId, patch.categoryIds, id)
      db.prepare('DELETE FROM budget_category WHERE budget_id = ?').run(id)
      for (const c of patch.categoryIds) db.prepare('INSERT INTO budget_category (budget_id, category_id) VALUES (?,?)').run(id, c)
    }
  })()
}

export function deleteBudget(db: Db, profileId: number, id: number): void {
  owned(db, profileId, id)
  db.prepare('DELETE FROM budget WHERE id = ?').run(id) // budget_category rows cascade; transactions are untouched
}

export interface BudgetLine extends BudgetStatus { id: number; name: string; categoryIds: number[]; categoryNames: string[]; projectedCents: number | null }
export interface BudgetReport {
  month: string
  lines: BudgetLine[]
  unbudgeted: { categoryId: number; name: string; spentCents: number }[]
  totals: { budgetCents: number; spentCents: number; remainingCents: number }
  inProgress: boolean
}

/** Spending per category for a month: expenses minus refunds (transfers and unreviewed rows never count). */
export function spendByCategory(db: Db, profileId: number, month: string): Map<number, number> {
  const rows = db.prepare(`SELECT category_id AS c, SUM(-amount_cents) AS s FROM txn WHERE profile_id = ? AND kind IN ('expense','refund') AND category_id IS NOT NULL AND posted_date BETWEEN ? AND ? GROUP BY category_id`).all(profileId, monthStart(month), monthEnd(month)) as { c: number; s: number }[]
  // a subcategory counts toward its main category's budget, unless it has a budget of its own
  const parent = new Map((db.prepare('SELECT id, parent_id AS p FROM category WHERE profile_id = ? AND parent_id IS NOT NULL').all(profileId) as { id: number; p: number }[]).map((r) => [r.id, r.p]))
  const own = new Set((db.prepare('SELECT bc.category_id AS c FROM budget_category bc JOIN budget b ON b.id = bc.budget_id WHERE b.profile_id = ?').all(profileId) as { c: number }[]).map((r) => r.c))
  const out = new Map<number, number>()
  for (const r of rows) {
    const id = parent.has(r.c) && !own.has(r.c) ? parent.get(r.c)! : r.c
    out.set(id, (out.get(id) ?? 0) + r.s)
  }
  return out
}

export function budgetReport(db: Db, profileId: number, month: string, today: string): BudgetReport {
  const budgets = listBudgets(db, profileId)
  const names = new Map((db.prepare('SELECT id, name FROM category WHERE profile_id = ?').all(profileId) as { id: number; name: string }[]).map((c) => [c.id, c.name]))
  const { lines, unbudgeted } = allocateSpending(budgets, spendByCategory(db, profileId, month))
  const inProgress = monthKey(today) === month
  const day = inProgress ? Number(today.slice(8, 10)) : 0
  const out: BudgetLine[] = lines.map((l) => {
    const b = budgets.find((x) => x.id === l.id)!
    return { ...budgetStatus(l.monthlyCents, l.spentCents), id: l.id, name: l.name, categoryIds: b.categoryIds, categoryNames: b.categoryIds.map((c) => names.get(c) ?? '?'), projectedCents: inProgress ? projectMonthEnd(l.spentCents, day, month) : null }
  })
  const budgetCents = out.reduce((s, l) => s + l.budgetCents, 0)
  const spentCents = out.reduce((s, l) => s + l.spentCents, 0)
  return { month, lines: out, unbudgeted: unbudgeted.map((u) => ({ ...u, name: names.get(u.categoryId) ?? 'Uncategorized' })), totals: { budgetCents, spentCents, remainingCents: budgetCents - spentCents }, inProgress }
}

export interface BudgetSuggestions {
  /** The months the averages come from (complete months that have any spending recorded). */
  months: string[]
  suggestions: (BudgetSuggestion & { categoryId: number })[]
}

/**
 * "Suggest budgets from my last 3 months": the average monthly spending per category over the last three complete
 * months, skipping categories that already belong to a budget. Months before the person's first transaction are not
 * counted as zero (a new user with one month of data gets that month's numbers, not a third of them).
 */
export function suggestBudgets(db: Db, profileId: number, today: string): BudgetSuggestions {
  const window = lastCompleteMonths(today, 3)
  const withData = window.filter((m) => (db.prepare(`SELECT 1 FROM txn WHERE profile_id = ? AND kind IN ('expense','refund') AND posted_date BETWEEN ? AND ? LIMIT 1`).get(profileId, monthStart(m), monthEnd(m))))
  if (withData.length === 0) return { months: [], suggestions: [] }
  const spend = withData.map((m) => spendByCategory(db, profileId, m))
  const existing = listBudgets(db, profileId)
  const covered = new Set(existing.flatMap((b) => b.categoryIds))
  const taken = new Set(existing.map((b) => b.name.toLowerCase()))
  const cats = db.prepare("SELECT id, name FROM category WHERE profile_id = ? AND kind = 'expense'").all(profileId) as { id: number; name: string }[]
  const items = cats.filter((c) => !covered.has(c.id)).map((c) => ({ key: String(c.id), name: taken.has(c.name.toLowerCase()) ? `${c.name} (suggested)` : c.name, monthlyCents: spend.map((s) => Math.max(0, s.get(c.id) ?? 0)) }))
  return { months: withData, suggestions: suggestLimits(items).map((s) => ({ ...s, categoryId: Number(s.key) })) }
}

/** Creates several budgets at once, or none if any of them is invalid. */
export function createBudgets(db: Db, profileId: number, items: { name: string; monthlyCents: number; categoryIds: number[] }[]): number[] {
  return db.transaction(() => items.map((i) => createBudget(db, profileId, i.name, i.monthlyCents, i.categoryIds)))()
}

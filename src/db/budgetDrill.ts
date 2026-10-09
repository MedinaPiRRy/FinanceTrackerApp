// "Which transactions make up this budget?": the month's spending in the budget's categories, one column per account.
// Same rule as the budget figures: expenses minus refunds (transfers and rows still in the review queue never count).
import type { Db } from './open'
import { monthEnd, monthStart } from '../core/budgets'
import { groupOf } from '../core/groups'
import { listBudgets } from './budgets'
import { listHouseholdBudgets, listOwners } from './household'

export interface DrillRow { id: number; accountId: number; date: string; description: string; category: string | null; /** Spending: positive for a purchase, negative for a refund. */ cents: number }
export interface DrillColumn { accountId: number; account: string; /** Whose account it is (household view only). */ owner: string | null; totalCents: number; rows: DrillRow[]; /** Rows beyond the cap, not shown. */ hidden: number }
export interface BudgetDrill { name: string; month: string; budgetCents: number; totalCents: number; columns: DrillColumn[] }

/** A column shows at most this many rows; the total still counts all of them. */
export const DRILL_ROW_CAP = 200

function build(db: Db, name: string, month: string, budgetCents: number, categoryIds: number[]): BudgetDrill {
  // a budget on a main category also covers its subcategories, unless one of them has a budget of its own
  const own = new Set((db.prepare('SELECT category_id AS c FROM budget_category').all() as { c: number }[]).map((r) => r.c))
  const kids = categoryIds.length ? (db.prepare(`SELECT id FROM category WHERE parent_id IN (${categoryIds.map(() => '?').join(',')})`).all(...categoryIds) as { id: number }[]).map((r) => r.id).filter((id) => !own.has(id)) : []
  categoryIds = [...new Set([...categoryIds, ...kids])]
  if (categoryIds.length === 0) return { name, month, budgetCents, totalCents: 0, columns: [] }
  const rows = db.prepare(`SELECT t.id, t.account_id AS accountId, a.name AS account, pr.name AS owner, pr.kind AS ownerKind, t.posted_date AS date, t.description, CASE WHEN pc.name IS NULL THEN c.name ELSE pc.name || ' › ' || c.name END AS category, -t.amount_cents AS cents
    FROM txn t JOIN account a ON a.id = t.account_id JOIN profile pr ON pr.id = t.profile_id LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category pc ON pc.id = c.parent_id
    WHERE t.kind IN ('expense','refund') AND t.category_id IN (${categoryIds.map(() => '?').join(',')}) AND t.posted_date BETWEEN ? AND ?
    ORDER BY t.posted_date DESC, t.id DESC`).all(...categoryIds, monthStart(month), monthEnd(month)) as (DrillRow & { account: string; owner: string; ownerKind: string })[]
  const cols = new Map<number, DrillColumn & { all: DrillRow[] }>()
  for (const r of rows) {
    const col = cols.get(r.accountId) ?? { accountId: r.accountId, account: r.account, owner: r.owner, totalCents: 0, rows: [], hidden: 0, all: [] }
    col.totalCents += r.cents
    col.all.push({ id: r.id, accountId: r.accountId, date: r.date, description: r.description, category: r.category, cents: r.cents })
    cols.set(r.accountId, col)
  }
  const columns = [...cols.values()].map(({ all, ...c }) => ({ ...c, rows: all.slice(0, DRILL_ROW_CAP), hidden: Math.max(0, all.length - DRILL_ROW_CAP) })).sort((a, b) => b.totalCents - a.totalCents)
  return { name, month, budgetCents, totalCents: columns.reduce((s, c) => s + c.totalCents, 0), columns }
}

export function budgetDrill(db: Db, profileId: number, budgetId: number, month: string): BudgetDrill {
  const b = listBudgets(db, profileId).find((x) => x.id === budgetId)
  if (!b) throw new Error('That budget no longer exists. Reload the page.')
  const drill = build(db, b.name, month, b.monthlyCents, b.categoryIds)
  return { ...drill, columns: drill.columns.map((c) => ({ ...c, owner: null })) }
}

/** A household budget covers category groups across every owner (each person and the shared accounts). */
export function householdBudgetDrill(db: Db, budgetId: number, month: string): BudgetDrill {
  const b = listHouseholdBudgets(db).find((x) => x.id === budgetId)
  if (!b) throw new Error('That budget no longer exists. Reload the page.')
  const ids = listOwners(db).map((o) => o.profileId)
  const cats = db.prepare(`SELECT c.id, COALESCE(pc.name, c.name) AS name, COALESCE(pc.group_name, c.group_name) AS groupName FROM category c LEFT JOIN category pc ON pc.id = c.parent_id WHERE c.profile_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: number; name: string; groupName: string | null }[]
  const covered = new Set(b.groups)
  return build(db, b.name, month, b.monthlyCents, cats.filter((c) => covered.has(groupOf(c))).map((c) => c.id))
}

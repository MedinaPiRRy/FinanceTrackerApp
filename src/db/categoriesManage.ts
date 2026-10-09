// The category manager in Settings: see every category with how much it is used, rename it, put it in a budget,
// delete it (moving what uses it somewhere else). Creating a category stays in `createCategory`.
import type { Db } from './open'

export interface CategoryRow {
  id: number
  name: string
  kind: 'expense' | 'income'
  txnCount: number
  /** Learned or chosen merchant names that point at this category. */
  ruleCount: number
  goalCount: number
  budgetId: number | null
  budgetName: string | null
}

export function listCategoryManage(db: Db, profileId: number): CategoryRow[] {
  return db.prepare(`SELECT c.id, c.name, c.kind,
      (SELECT COUNT(*) FROM txn t WHERE t.category_id = c.id) AS txnCount,
      (SELECT COUNT(*) FROM category_rule r WHERE r.category_id = c.id) + (SELECT COUNT(*) FROM source_rule s WHERE s.category_id = c.id) AS ruleCount,
      (SELECT COUNT(*) FROM goal g WHERE g.category_id = c.id) AS goalCount,
      b.id AS budgetId, b.name AS budgetName
    FROM category c LEFT JOIN budget_category bc ON bc.category_id = c.id LEFT JOIN budget b ON b.id = bc.budget_id
    WHERE c.profile_id = ? ORDER BY c.kind DESC, c.name COLLATE NOCASE`).all(profileId) as CategoryRow[]
}

function owned(db: Db, profileId: number, id: number) {
  const c = db.prepare('SELECT id, name, kind, profile_id AS p FROM category WHERE id = ?').get(id) as { id: number; name: string; kind: 'expense' | 'income'; p: number } | undefined
  if (!c || c.p !== profileId) throw new Error('That category no longer exists. Reload the page.')
  return c
}

export function renameCategory(db: Db, profileId: number, id: number, name: string): void {
  const c = owned(db, profileId, id)
  const clean = name.trim().replace(/\s+/g, ' ')
  if (!clean) throw new Error('Category name cannot be empty')
  if (clean.length > 60) throw new Error('Category name is too long')
  if (db.prepare('SELECT 1 FROM category WHERE profile_id = ? AND kind = ? AND name = ? COLLATE NOCASE AND id <> ?').get(profileId, c.kind, clean, id)) throw new Error(`There is already a ${c.kind === 'income' ? 'income' : 'spending'} category called "${clean}"`)
  db.prepare('UPDATE category SET name = ? WHERE id = ?').run(clean, id)
}

/** Puts a spending category in a budget (or none). A category is in at most one budget. */
export function setCategoryBudget(db: Db, profileId: number, categoryId: number, budgetId: number | null): void {
  const c = owned(db, profileId, categoryId)
  if (c.kind !== 'expense') throw new Error('Budgets cover spending categories only')
  if (budgetId !== null && !db.prepare('SELECT 1 FROM budget WHERE id = ? AND profile_id = ?').get(budgetId, profileId)) throw new Error('That budget no longer exists. Reload the page.')
  db.transaction(() => {
    db.prepare('DELETE FROM budget_category WHERE category_id = ?').run(categoryId)
    if (budgetId !== null) db.prepare('INSERT INTO budget_category (budget_id, category_id) VALUES (?,?)').run(budgetId, categoryId)
  })()
}

/**
 * Deletes a category. If anything uses it (transactions or a goal) a category of the same kind must be named to take them over;
 * remembered merchant names and the budget membership move with it. A category nothing uses is simply removed.
 */
export function deleteCategory(db: Db, profileId: number, id: number, moveToId: number | null): { moved: number } {
  const c = owned(db, profileId, id)
  const used = (db.prepare('SELECT (SELECT COUNT(*) FROM txn WHERE category_id = ?) + (SELECT COUNT(*) FROM goal WHERE category_id = ?) AS n').get(id, id) as { n: number }).n
  let target: { id: number; kind: string } | null = null
  if (moveToId !== null) {
    if (moveToId === id) throw new Error('Pick a different category to move things to.')
    target = owned(db, profileId, moveToId)
    if (target.kind !== c.kind) throw new Error(`Move them to a ${c.kind === 'income' ? 'income' : 'spending'} category.`)
  } else if (used > 0) {
    throw new Error('Pick the category to move its transactions to first.')
  }
  let moved = 0
  db.transaction(() => {
    if (target) {
      moved = db.prepare('UPDATE txn SET category_id = ? WHERE category_id = ?').run(target.id, id).changes
      db.prepare('UPDATE goal SET category_id = ? WHERE category_id = ?').run(target.id, id)
      db.prepare('UPDATE category_rule SET category_id = ? WHERE category_id = ?').run(target.id, id)
      db.prepare('UPDATE source_rule SET category_id = ? WHERE category_id = ?').run(target.id, id)
      const inBudget = db.prepare('SELECT 1 FROM budget_category WHERE category_id = ?').get(target.id)
      if (inBudget) db.prepare('DELETE FROM budget_category WHERE category_id = ?').run(id)
      else db.prepare('UPDATE budget_category SET category_id = ? WHERE category_id = ?').run(target.id, id)
    } else {
      db.prepare('DELETE FROM budget_category WHERE category_id = ?').run(id)
      db.prepare('DELETE FROM category_rule WHERE category_id = ?').run(id)
      db.prepare('DELETE FROM source_rule WHERE category_id = ?').run(id)
    }
    db.prepare('DELETE FROM category WHERE id = ?').run(id)
  })()
  return { moved }
}

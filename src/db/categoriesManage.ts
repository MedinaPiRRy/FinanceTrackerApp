// The category manager in Settings: see every category with how much it is used, rename it, put it in a budget, give it
// subcategories, say what it counts as (taxes / interest), delete it (moving what uses it somewhere else).
// Creating a category (or a subcategory) is `createCategory` in queries.ts.
import type { Db } from './open'
import { guessPurpose, type Purpose } from '../core/costs'

export interface CategoryRow {
  id: number
  name: string
  kind: 'expense' | 'income'
  /** Set for a subcategory. */
  parentId: number | null
  parentName: string | null
  /** Transactions filed directly in this category (a main category's count does not include its subcategories). */
  txnCount: number
  /** Learned or chosen merchant names that point at this category. */
  ruleCount: number
  goalCount: number
  /** Rules that depend on the amount and use this category. */
  amountRuleCount: number
  budgetId: number | null
  budgetName: string | null
  /** What the person set it to ('tax' | 'interest' | 'none'), or null when never set. */
  purpose: Purpose | null
  /** What it counts as now: the person's setting, else a guess from the name. */
  effectivePurpose: Purpose
}

export function listCategoryManage(db: Db, profileId: number): CategoryRow[] {
  const rows = db.prepare(`SELECT c.id, c.name, c.kind, c.parent_id AS parentId, p.name AS parentName, c.purpose,
      (SELECT COUNT(*) FROM txn t WHERE t.category_id = c.id) AS txnCount,
      (SELECT COUNT(*) FROM category_rule r WHERE r.category_id = c.id) + (SELECT COUNT(*) FROM source_rule s WHERE s.category_id = c.id) AS ruleCount,
      (SELECT COUNT(*) FROM goal g WHERE g.category_id = c.id) AS goalCount,
      (SELECT COUNT(*) FROM amount_rule a WHERE a.low_category_id = c.id OR a.high_category_id = c.id) AS amountRuleCount,
      b.id AS budgetId, b.name AS budgetName
    FROM category c LEFT JOIN category p ON p.id = c.parent_id LEFT JOIN budget_category bc ON bc.category_id = c.id LEFT JOIN budget b ON b.id = bc.budget_id
    WHERE c.profile_id = ? ORDER BY c.kind DESC, COALESCE(p.name, c.name) COLLATE NOCASE, c.parent_id IS NOT NULL, c.name COLLATE NOCASE`).all(profileId) as (Omit<CategoryRow, 'effectivePurpose' | 'purpose'> & { purpose: string | null })[]
  return rows.map((r) => {
    const purpose = r.purpose === 'tax' || r.purpose === 'interest' || r.purpose === 'none' ? r.purpose : null
    return { ...r, purpose, effectivePurpose: purpose ?? (r.kind === 'expense' ? guessPurpose(r.parentName ?? r.name) : 'none') }
  })
}

function owned(db: Db, profileId: number, id: number) {
  const c = db.prepare('SELECT id, name, kind, profile_id AS p, parent_id AS parentId FROM category WHERE id = ?').get(id) as { id: number; name: string; kind: 'expense' | 'income'; p: number; parentId: number | null } | undefined
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

/** What a spending category counts as on the Taxes & interest page. `null` goes back to guessing from the name. */
export function setCategoryPurpose(db: Db, profileId: number, categoryId: number, purpose: Purpose | null): void {
  const c = owned(db, profileId, categoryId)
  if (c.kind !== 'expense') throw new Error('Only spending categories count as taxes or interest')
  if (purpose !== null && !['tax', 'interest', 'none'].includes(purpose)) throw new Error('Choose Taxes, Interest or Neither.')
  db.prepare('UPDATE category SET purpose = ? WHERE id = ?').run(purpose, categoryId)
}

/**
 * Makes a category a subcategory of another (or a main category again with `parentId` null). Only one level: the parent has to be a
 * main category, and a category that has subcategories cannot become one. Both must be the same kind.
 */
export function setCategoryParent(db: Db, profileId: number, categoryId: number, parentId: number | null): void {
  const c = owned(db, profileId, categoryId)
  if (parentId !== null) {
    if (parentId === categoryId) throw new Error('A category cannot sit under itself.')
    const p = owned(db, profileId, parentId)
    if (p.kind !== c.kind) throw new Error('A subcategory has to be the same kind (spending or income) as its main category.')
    if (p.parentId !== null) throw new Error('A subcategory cannot have subcategories of its own. Pick a main category.')
    if (db.prepare('SELECT 1 FROM category WHERE parent_id = ?').get(categoryId)) throw new Error(`"${c.name}" has subcategories of its own, so it cannot become one. Move those out first.`)
  }
  db.prepare('UPDATE category SET parent_id = ? WHERE id = ?').run(parentId, categoryId)
}

/**
 * Deletes a category. If anything uses it (transactions, a goal or a rule that depends on the amount) a category of the same kind must
 * be named to take them over; remembered merchant names and the budget place move with it. A category nothing uses is simply removed.
 * A main category with subcategories cannot be deleted until they are deleted or moved out.
 */
export function deleteCategory(db: Db, profileId: number, id: number, moveToId: number | null): { moved: number } {
  const c = owned(db, profileId, id)
  const kids = (db.prepare('SELECT COUNT(*) n FROM category WHERE parent_id = ?').get(id) as { n: number }).n
  if (kids > 0) throw new Error(`"${c.name}" has ${kids} subcategor${kids === 1 ? 'y' : 'ies'}. Delete them (or move them under another category) first.`)
  const used = (db.prepare('SELECT (SELECT COUNT(*) FROM txn WHERE category_id = ?) + (SELECT COUNT(*) FROM goal WHERE category_id = ?) + (SELECT COUNT(*) FROM amount_rule WHERE low_category_id = ? OR high_category_id = ?) AS n').get(id, id, id, id) as { n: number }).n
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
      db.prepare('UPDATE amount_rule SET low_category_id = ? WHERE low_category_id = ?').run(target.id, id)
      db.prepare('UPDATE amount_rule SET high_category_id = ? WHERE high_category_id = ?').run(target.id, id)
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

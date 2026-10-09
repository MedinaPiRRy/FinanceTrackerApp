// Rules where the category depends on the amount: "at gas stations, up to $30 is snacks and drinks, more than that is gas".
// A merchant is matched by words in its cleaned-up name, so "PETRO" matches PETRO-CANADA at any branch. Only money going out is looked at.
import type { Db } from './open'
import { normalizeKey } from '../core/normalize'

export interface AmountRule {
  id: number
  name: string
  words: string[]
  limitCents: number
  lowCategoryId: number
  lowCategory: string
  highCategoryId: number
  highCategory: string
}

const label = (name: string, parent: string | null) => (parent ? `${parent} › ${name}` : name)

export function listAmountRules(db: Db, profileId: number): AmountRule[] {
  const rows = db.prepare(`SELECT r.id, r.name, r.words, r.limit_cents AS limitCents, r.low_category_id AS lowCategoryId, r.high_category_id AS highCategoryId,
      lo.name AS lowName, lp.name AS lowParent, hi.name AS highName, hp.name AS highParent
    FROM amount_rule r JOIN category lo ON lo.id = r.low_category_id LEFT JOIN category lp ON lp.id = lo.parent_id
    JOIN category hi ON hi.id = r.high_category_id LEFT JOIN category hp ON hp.id = hi.parent_id
    WHERE r.profile_id = ? ORDER BY r.id`).all(profileId) as { id: number; name: string; words: string; limitCents: number; lowCategoryId: number; highCategoryId: number; lowName: string; lowParent: string | null; highName: string; highParent: string | null }[]
  return rows.map((r) => ({ id: r.id, name: r.name, words: JSON.parse(r.words) as string[], limitCents: r.limitCents, lowCategoryId: r.lowCategoryId, lowCategory: label(r.lowName, r.lowParent), highCategoryId: r.highCategoryId, highCategory: label(r.highName, r.highParent) }))
}

export interface AmountRuleInput { name: string; words: string[]; limitCents: number; lowCategoryId: number; highCategoryId: number }

function clean(db: Db, profileId: number, i: AmountRuleInput): { name: string; words: string[] } {
  const name = i.name.trim()
  if (!name) throw new Error('Give the rule a name')
  const words = [...new Set(i.words.map((w) => w.trim().toUpperCase()).filter(Boolean))]
  if (words.length === 0) throw new Error('Type at least one word from the merchant’s name (for example PETRO or SHELL).')
  if (words.some((w) => w.length < 3)) throw new Error('Each word needs at least 3 letters, so it does not match unrelated merchants.')
  if (words.length > 30) throw new Error('That is a lot of words (30 at most).')
  if (!Number.isInteger(i.limitCents) || i.limitCents <= 0) throw new Error('The amount has to be more than zero.')
  for (const id of [i.lowCategoryId, i.highCategoryId]) {
    const c = db.prepare('SELECT profile_id AS p, kind FROM category WHERE id = ?').get(id) as { p: number; kind: string } | undefined
    if (!c || c.p !== profileId) throw new Error('That category no longer exists. Reload the page.')
    if (c.kind !== 'expense') throw new Error('The rule files spending, so both categories have to be spending categories.')
  }
  if (i.lowCategoryId === i.highCategoryId) throw new Error('Pick two different categories, or there is nothing to decide by amount.')
  return { name, words }
}

export function createAmountRule(db: Db, profileId: number, input: AmountRuleInput): number {
  const { name, words } = clean(db, profileId, input)
  return Number(db.prepare('INSERT INTO amount_rule (profile_id, name, words, limit_cents, low_category_id, high_category_id) VALUES (?,?,?,?,?,?)').run(profileId, name, JSON.stringify(words), input.limitCents, input.lowCategoryId, input.highCategoryId).lastInsertRowid)
}

export function updateAmountRule(db: Db, profileId: number, id: number, input: AmountRuleInput): void {
  if (!db.prepare('SELECT 1 FROM amount_rule WHERE id = ? AND profile_id = ?').get(id, profileId)) throw new Error('That rule no longer exists. Reload the page.')
  const { name, words } = clean(db, profileId, input)
  db.prepare('UPDATE amount_rule SET name = ?, words = ?, limit_cents = ?, low_category_id = ?, high_category_id = ? WHERE id = ?').run(name, JSON.stringify(words), input.limitCents, input.lowCategoryId, input.highCategoryId, id)
}

export function deleteAmountRule(db: Db, profileId: number, id: number): void {
  if (db.prepare('DELETE FROM amount_rule WHERE id = ? AND profile_id = ?').run(id, profileId).changes === 0) throw new Error('That rule no longer exists. Reload the page.')
}

export interface Matcher { words: string[]; limitCents: number; lowCategoryId: number; highCategoryId: number }

/** The category a rule picks for money going out, or null if no rule is about this merchant. `key` is the cleaned-up merchant name. */
export function amountCategory(rules: Matcher[], key: string, amountCents: number): number | null {
  if (amountCents >= 0) return null
  const k = key.toUpperCase()
  for (const r of rules) if (r.words.some((w) => hasWord(k, w))) return -amountCents <= r.limitCents ? r.lowCategoryId : r.highCategoryId
  return null
}

/** Whole-word match, so MOBIL finds "MOBIL" and "MOBIL 5512" but not "ROGERS MOBILE", and PETRO finds "PETRO-CANADA". */
function hasWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`).test(text)
}

export function loadAmountMatcher(db: Db, profileId: number): (key: string, amountCents: number) => number | null {
  const rules = listAmountRules(db, profileId)
  return rules.length === 0 ? () => null : (key, cents) => amountCategory(rules, key, cents)
}

export interface ApplyResult { matched: number; changed: number }

/**
 * Applies one rule to transactions already in the app. By default only purchases still waiting for a category; with `includeCategorised`
 * also bank-file purchases that were given a category automatically. Rows from the workbook, cash entries and anything typed by hand are never touched.
 */
export function applyAmountRule(db: Db, profileId: number, id: number, opts: { includeCategorised?: boolean; dryRun?: boolean } = {}): ApplyResult {
  const rule = listAmountRules(db, profileId).find((r) => r.id === id)
  if (!rule) throw new Error('That rule no longer exists. Reload the page.')
  const rows = db.prepare(`SELECT id, amount_cents AS cents, category_id AS cat, review_reason AS reason, source, COALESCE(description_raw, description) AS text
    FROM txn WHERE profile_id = ? AND kind = 'expense' AND amount_cents < 0 AND source IN ('import', 'sample')`).all(profileId) as { id: number; cents: number; cat: number | null; reason: string | null; source: string; text: string }[]
  let matched = 0, changed = 0
  const upd = db.prepare("UPDATE txn SET category_id = ?, review_reason = CASE WHEN review_reason = 'Needs a category' THEN NULL ELSE review_reason END, reviewed_at = CASE WHEN review_reason = 'Needs a category' THEN datetime('now') ELSE reviewed_at END WHERE id = ?")
  const apply = () => {
    for (const r of rows) {
      const pick = amountCategory([{ ...rule }], normalizeKey(r.text), r.cents)
      if (pick === null) continue
      const waiting = r.cat === null || r.reason === 'Needs a category'
      if (!waiting && !opts.includeCategorised) continue
      matched++
      if (r.cat === pick) continue
      changed++
      if (!opts.dryRun) upd.run(pick, r.id)
    }
  }
  if (opts.dryRun) apply(); else db.transaction(apply)()
  return { matched, changed }
}

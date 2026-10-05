import type { Db } from './open'
import { normalizeKey } from '../core/normalize'

/**
 * Remembers "this merchant belongs in this category" as one of the person's own rules (highest priority).
 * E-transfers are never remembered: who sent them and why changes every time, so the user decides each time.
 */
export function rememberCategory(db: Db, profileId: number, text: string, merchant: string, categoryId: number): boolean {
  if (/E-?TRANSFER/i.test(text)) return false
  const key = normalizeKey(text)
  if (key.length < 3) return false
  db.prepare(`DELETE FROM category_rule WHERE profile_id = ? AND pattern = ? AND source = 'user'`).run(profileId, key)
  db.prepare(`INSERT INTO category_rule (profile_id, pattern, match_type, merchant, category_id, priority, source) VALUES (?,?,'exact',?,?,10,'user')`).run(profileId, key, merchant, categoryId)
  return true
}

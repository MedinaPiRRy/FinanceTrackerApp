// "Always file money from this source this way": the person's own standing decision about a source (for an e-transfer,
// the other person's name). Only ever created when the person ticks the box; nothing here guesses.
import type { Db } from './open'
import { displayName } from '../core/normalize'

export type RuleKind = 'income' | 'expense' | 'refund' | 'transfer'
export type Direction = 'in' | 'out'

export interface SourceRule { id: number; sourceKey: string; name: string; direction: Direction; kind: RuleKind; categoryId: number | null; categoryName: string | null; /** An expense rule can also count the payment toward a loan. */ debtId: number | null; debtName: string | null; createdAt: string }

export const directionOf = (amountCents: number): Direction => (amountCents > 0 ? 'in' : 'out')

export function listSourceRules(db: Db, profileId: number): SourceRule[] {
  const rows = db.prepare(`SELECT r.id, r.source_key AS sourceKey, r.direction, r.kind, r.category_id AS categoryId, c.name AS categoryName, r.debt_id AS debtId, dd.name AS debtName, r.created_at AS createdAt
    FROM source_rule r LEFT JOIN category c ON c.id = r.category_id LEFT JOIN debt dd ON dd.id = r.debt_id WHERE r.profile_id = ? ORDER BY r.source_key, r.direction`).all(profileId) as Omit<SourceRule, 'name'>[]
  return rows.map((r) => ({ ...r, name: displayName(r.sourceKey) || r.sourceKey }))
}

/** The rule for this source and direction, if the person made one. */
export function findSourceRule(db: Db, profileId: number, sourceKey: string, direction: Direction): { kind: RuleKind; categoryId: number | null; debtId: number | null } | null {
  const r = db.prepare('SELECT kind, category_id AS categoryId, debt_id AS debtId FROM source_rule WHERE profile_id = ? AND source_key = ? AND direction = ?').get(profileId, sourceKey, direction) as { kind: RuleKind; categoryId: number | null; debtId: number | null } | undefined
  return r ?? null
}

export function addSourceRule(db: Db, profileId: number, sourceKey: string, direction: Direction, kind: RuleKind, categoryId: number | null, debtId: number | null = null): void {
  if (sourceKey.trim().length < 2) throw new Error('This line has no name the app could recognise next time, so it cannot be remembered.')
  if (kind === 'income' && direction !== 'in') throw new Error('Income must be money coming in')
  if (kind === 'refund' && direction !== 'in') throw new Error('A refund must be money coming in')
  if (kind === 'expense' && direction !== 'out') throw new Error('An expense must be money going out')
  if (kind !== 'transfer' && categoryId === null) throw new Error('Pick a category to remember')
  if (debtId !== null && kind !== 'expense') throw new Error('Only an expense can count toward a loan')
  db.prepare(`INSERT INTO source_rule (profile_id, source_key, direction, kind, category_id, debt_id) VALUES (?,?,?,?,?,?)
    ON CONFLICT(profile_id, source_key, direction) DO UPDATE SET kind = excluded.kind, category_id = excluded.category_id, debt_id = excluded.debt_id`).run(profileId, sourceKey, direction, kind, kind === 'transfer' ? null : categoryId, debtId)
}

export function deleteSourceRule(db: Db, profileId: number, id: number): void {
  const n = db.prepare('DELETE FROM source_rule WHERE id = ? AND profile_id = ?').run(id, profileId).changes
  if (n === 0) throw new Error('That remembered source no longer exists. Reload the page.')
}

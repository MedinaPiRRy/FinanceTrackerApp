import type { Db } from './open'
import { accountValueCents } from './review'
import { computeGoal, type GoalKind, type GoalProgress } from '../core/goals'

export interface DebtItem { accountId?: number; debtId?: number }

export interface GoalDto {
  name: string
  kind: GoalKind
  targetCents?: number
  manualCents?: number
  deadline?: string | null
  plannedMonthlyCents?: number | null
  accountId?: number | null
  categoryId?: number | null
  debtItems?: DebtItem[]
  notes?: string | null
}

export interface GoalView {
  id: number
  name: string
  kind: GoalKind
  targetCents: number
  manualCents: number
  deadline: string | null
  plannedMonthlyCents: number | null
  notes: string | null
  accountId: number | null
  accountName: string | null
  categoryId: number | null
  categoryName: string | null
  items: { type: 'card' | 'loan'; accountId?: number; debtId?: number; label: string; owedCents: number }[]
  progress: GoalProgress
}

const iso = /^\d{4}-\d{2}-\d{2}$/

/** Household goals may use anyone's accounts, categories and debts; personal goals only their own. */
const reaches = (db: Db, profileId: number, ownerOfThing: number) => ownerOfThing === profileId || (db.prepare('SELECT kind FROM profile WHERE id = ?').get(profileId) as { kind: string } | undefined)?.kind === 'household'

function itemOwed(db: Db, profileId: number, it: DebtItem): { type: 'card' | 'loan'; label: string; owedCents: number } {
  if (it.accountId) {
    const a = db.prepare('SELECT id, name, type, profile_id p FROM account WHERE id = ?').get(it.accountId) as { id: number; name: string; type: string; p: number } | undefined
    if (!a || !reaches(db, profileId, a.p)) throw new Error('That card is not one of yours.')
    if (a.type !== 'credit_card') throw new Error(`"${a.name}" is not a credit card`)
    return { type: 'card', label: a.name, owedCents: Math.max(0, -(accountValueCents(db, a.id) ?? 0)) }
  }
  const d = db.prepare('SELECT name, balance_cents b, profile_id p FROM debt WHERE id = ?').get(it.debtId) as { name: string; b: number; p: number } | undefined
  if (!d || !reaches(db, profileId, d.p)) throw new Error('That loan is not one of yours.')
  return { type: 'loan', label: d.name, owedCents: d.b }
}

function validate(db: Db, profileId: number, dto: GoalDto) {
  if (!dto.name.trim()) throw new Error('Give the goal a name')
  if (dto.deadline && !iso.test(dto.deadline)) throw new Error('Deadline must be a date')
  if (dto.plannedMonthlyCents != null && (!Number.isInteger(dto.plannedMonthlyCents) || dto.plannedMonthlyCents < 0)) throw new Error('The monthly amount cannot be negative')
  if (dto.manualCents != null && (!Number.isInteger(dto.manualCents) || dto.manualCents < 0)) throw new Error('The amount saved cannot be negative')
  if (dto.kind === 'account') {
    const a = dto.accountId ? (db.prepare('SELECT profile_id p, type FROM account WHERE id = ?').get(dto.accountId) as { p: number; type: string } | undefined) : undefined
    if (!a || !reaches(db, profileId, a.p)) throw new Error('Choose one of your own accounts to track')
    if (a.type === 'credit_card') throw new Error('A savings goal cannot track a credit card')
  }
  if (dto.kind === 'category') {
    const c = dto.categoryId ? (db.prepare('SELECT profile_id p, kind FROM category WHERE id = ?').get(dto.categoryId) as { p: number; kind: string } | undefined) : undefined
    if (!c || !reaches(db, profileId, c.p) || c.kind !== 'expense') throw new Error('Choose one of your spending categories to track')
  }
  if (dto.kind !== 'debt' && (!dto.targetCents || !Number.isInteger(dto.targetCents) || dto.targetCents <= 0)) throw new Error('The target must be more than zero')
}

function debtBaseline(db: Db, profileId: number, items: DebtItem[]): number {
  if (!items.length) throw new Error('Pick at least one card or loan to pay off')
  const total = items.reduce((s, it) => s + itemOwed(db, profileId, it).owedCents, 0)
  if (total <= 0) throw new Error('Nothing is owed on these yet, so there is nothing to pay off')
  return total
}

export function createGoal(db: Db, profileId: number, dto: GoalDto): number {
  validate(db, profileId, dto)
  return db.transaction(() => {
    const baseline = dto.kind === 'debt' ? debtBaseline(db, profileId, dto.debtItems ?? []) : null
    const id = Number(
      db.prepare(`INSERT INTO goal (profile_id, name, kind, target_cents, manual_cents, baseline_cents, deadline, planned_monthly_cents, account_id, category_id, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(profileId, dto.name.trim(), dto.kind, baseline ?? dto.targetCents, dto.manualCents ?? 0, baseline, dto.deadline ?? null, dto.plannedMonthlyCents ?? null, dto.kind === 'account' ? dto.accountId : null, dto.kind === 'category' ? dto.categoryId : null, dto.notes ?? null).lastInsertRowid
    )
    if (dto.kind === 'debt') for (const it of dto.debtItems!) db.prepare('INSERT INTO goal_debt (goal_id, account_id, debt_id) VALUES (?,?,?)').run(id, it.accountId ?? null, it.debtId ?? null)
    return id
  })()
}

/** Debt goals: changing which cards/loans are included starts progress again from what is owed now. */
export function updateGoal(db: Db, profileId: number, id: number, dto: GoalDto): void {
  const g = db.prepare('SELECT kind FROM goal WHERE id = ? AND profile_id = ?').get(id, profileId) as { kind: GoalKind } | undefined
  if (!g) throw new Error('That goal no longer exists. Reload the page.')
  if (dto.kind !== g.kind) throw new Error('A goal\'s type cannot be changed; create a new goal instead')
  validate(db, profileId, dto)
  db.transaction(() => {
    db.prepare(`UPDATE goal SET name = ?, manual_cents = ?, deadline = ?, planned_monthly_cents = ?, account_id = ?, category_id = ?, notes = ? WHERE id = ?`)
      .run(dto.name.trim(), dto.manualCents ?? 0, dto.deadline ?? null, dto.plannedMonthlyCents ?? null, dto.kind === 'account' ? dto.accountId : null, dto.kind === 'category' ? dto.categoryId : null, dto.notes ?? null, id)
    if (dto.kind === 'debt') {
      if (dto.debtItems) {
        const baseline = debtBaseline(db, profileId, dto.debtItems)
        db.prepare('DELETE FROM goal_debt WHERE goal_id = ?').run(id)
        for (const it of dto.debtItems) db.prepare('INSERT INTO goal_debt (goal_id, account_id, debt_id) VALUES (?,?,?)').run(id, it.accountId ?? null, it.debtId ?? null)
        db.prepare('UPDATE goal SET baseline_cents = ?, target_cents = ? WHERE id = ?').run(baseline, baseline, id)
      }
    } else db.prepare('UPDATE goal SET target_cents = ? WHERE id = ?').run(dto.targetCents, id)
  })()
}

export function deleteGoal(db: Db, profileId: number, id: number): void {
  if (!db.prepare('SELECT 1 FROM goal WHERE id = ? AND profile_id = ?').get(id, profileId)) throw new Error('That goal no longer exists. Reload the page.')
  db.prepare('DELETE FROM goal WHERE id = ?').run(id)
}

export function listGoals(db: Db, profileId: number, today: string): GoalView[] {
  const rows = db.prepare('SELECT * FROM goal WHERE profile_id = ? ORDER BY id').all(profileId) as Record<string, unknown>[]
  return rows.map((r) => {
    const id = r.id as number
    const kind = r.kind as GoalKind
    const target = r.target_cents as number
    const manual = r.manual_cents as number
    const accountId = (r.account_id as number) ?? null
    const categoryId = (r.category_id as number) ?? null
    const items = kind === 'debt'
      ? (db.prepare('SELECT account_id a, debt_id d FROM goal_debt WHERE goal_id = ?').all(id) as { a: number | null; d: number | null }[]).map((x) => {
          const it = x.a ? { accountId: x.a } : { debtId: x.d! }
          return { ...it, ...itemOwed(db, profileId, it) }
        })
      : []
    let achieved: number | null
    let owed: number | undefined
    if (kind === 'manual') achieved = manual
    else if (kind === 'account') achieved = accountId ? accountValueCents(db, accountId) : null
    else if (kind === 'category') {
      const s = db.prepare(`SELECT COALESCE(SUM(-amount_cents),0) s FROM txn WHERE category_id IN (SELECT id FROM category WHERE id = ? OR parent_id = ?) AND kind IN ('expense','refund')`).get(categoryId, categoryId) as { s: number }
      achieved = manual + s.s
    } else {
      owed = items.reduce((s, x) => s + x.owedCents, 0)
      achieved = Math.max(0, ((r.baseline_cents as number) ?? target) - owed)
    }
    return {
      id, name: r.name as string, kind, targetCents: target, manualCents: manual, deadline: (r.deadline as string) ?? null, plannedMonthlyCents: (r.planned_monthly_cents as number) ?? null, notes: (r.notes as string) ?? null,
      accountId, accountName: accountId ? (db.prepare('SELECT name FROM account WHERE id = ?').get(accountId) as { name: string }).name : null,
      categoryId, categoryName: categoryId ? (db.prepare('SELECT name FROM category WHERE id = ?').get(categoryId) as { name: string }).name : null,
      items: items.map(({ type, label, owedCents, ...rest }) => ({ type, label, owedCents, ...rest })),
      progress: computeGoal({ kind, targetCents: target, achievedCents: achieved, owedCents: owed, deadline: (r.deadline as string) ?? null, plannedMonthlyCents: (r.planned_monthly_cents as number) ?? null, today })
    }
  })
}

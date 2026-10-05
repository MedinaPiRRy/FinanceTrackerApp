// Goal ideas for a person or for the household, built from their real recent numbers (see core/goalIdeas).
import type { Db } from './open'
import { suggestIdeas, type GoalIdea } from '../core/goalIdeas'
import { createGoal, listGoals, type GoalDto } from './goals'
import { accountValueCents } from './review'
import { listOwners } from './household'
import { recentAverages } from './averages'

export interface GoalIdeas { months: string[]; avgMonthlyIncomeCents: number | null; avgMonthlySpendCents: number | null; ideas: GoalIdea[] }

export function goalIdeas(db: Db, profileId: number, today: string): GoalIdeas {
  const profile = db.prepare('SELECT kind FROM profile WHERE id = ?').get(profileId) as { kind: string } | undefined
  if (!profile) throw new Error('That person no longer exists. Reload the page.')
  const household = profile.kind === 'household'
  const owners = household ? listOwners(db).map((o) => o.profileId) : [profileId]
  const { months, income, spend } = recentAverages(db, owners, today)
  const marks = owners.map(() => '?').join(',')

  const accounts = db.prepare(`SELECT id, name, type, profile_id AS p FROM account WHERE profile_id IN (${marks}) AND archived = 0`).all(...owners) as { id: number; name: string; type: string; p: number }[]
  const value = (id: number) => accountValueCents(db, id)
  const savings = accounts.filter((a) => a.type === 'savings')
  const cards = accounts.filter((a) => a.type === 'credit_card').map((a) => ({ accountId: a.id, name: a.name, owedCents: Math.max(0, -(value(a.id) ?? 0)) }))
  const loans = (db.prepare(`SELECT id, name, balance_cents AS b FROM debt WHERE profile_id IN (${marks}) AND balance_cents > 0`).all(...owners) as { id: number; name: string; b: number }[]).map((d) => ({ debtId: d.id, name: d.name, balanceCents: d.b }))

  // What is already being worked on. Cards and loans are checked against everyone's goals; the rest against this profile's.
  const mine = listGoals(db, profileId, today)
  const everyones = owners.flatMap((o) => listGoals(db, o, today))
  const debtItems = everyones.filter((g) => g.kind === 'debt').flatMap((g) => g.items)
  const ideas = suggestIdeas({
    today, avgMonthlyIncomeCents: income, avgMonthlySpendCents: spend,
    savingsAccounts: savings.filter((a) => a.p === profileId).map((a) => ({ id: a.id, name: a.name, valueCents: value(a.id) })),
    cushionCents: savings.reduce((s, a) => s + Math.max(0, value(a.id) ?? 0), 0),
    investments: accounts.filter((a) => a.type === 'investment' && a.p === profileId).map((a) => ({ id: a.id, name: a.name, valueCents: value(a.id) })),
    cards, loans,
    existing: {
      emergency: mine.some((g) => /emergency|rainy|buffer|cushion/i.test(g.name)),
      cardIds: debtItems.filter((x) => x.type === 'card').map((x) => x.accountId!).filter(Boolean),
      loanIds: debtItems.filter((x) => x.type === 'loan').map((x) => x.debtId!).filter(Boolean),
      accountIds: mine.map((g) => g.accountId).filter((x): x is number => x !== null),
      savingHabit: mine.some((g) => /\bsav(e|ing)/i.test(g.name))
    }
  })
  return { months, avgMonthlyIncomeCents: income, avgMonthlySpendCents: spend, ideas }
}

/** Creates the chosen ideas as real goals. The facts come from the data again; only the key, a new name and a new monthly amount come from the UI. */
export function createGoalsFromIdeas(db: Db, profileId: number, picks: { key: string; name?: string; plannedMonthlyCents?: number | null }[], today: string): number[] {
  const found = new Map(goalIdeas(db, profileId, today).ideas.map((i) => [i.key, i]))
  return db.transaction(() => picks.map((p) => {
    const idea = found.get(p.key)
    if (!idea) throw new Error('That idea is no longer available (the goal may already exist).')
    const edited = p.plannedMonthlyCents !== undefined && p.plannedMonthlyCents !== idea.plannedMonthlyCents
    const dto: GoalDto = {
      name: (p.name ?? idea.title).trim() || idea.title, kind: idea.kind, targetCents: idea.targetCents, accountId: idea.accountId ?? null, debtItems: idea.debtItems,
      plannedMonthlyCents: edited ? p.plannedMonthlyCents : idea.plannedMonthlyCents,
      deadline: edited ? null : idea.deadline, // a deadline that no longer matches the edited amount would only confuse
      notes: idea.notes
    }
    return createGoal(db, profileId, dto)
  }))()
}

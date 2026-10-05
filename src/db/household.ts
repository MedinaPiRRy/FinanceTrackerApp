// The combined household view. Nothing here merges the two people's data: every figure is computed per owner
// (each person, plus the shared accounts) and then added up, so the split is always available.
import type { Db } from './open'
import { groupOf } from '../core/groups'
import { monthKey } from '../core/dates'
import { monthEnd, monthStart, budgetStatus, suggestLimits, lastCompleteMonths, type BudgetStatus, type BudgetSuggestion } from '../core/budgets'
import { listAccounts, type AccountInfo } from './queries'
import { listGoals, type GoalView } from './goals'
import { formatCents } from '../core/money'
import { monthLabel } from '../core/insights'

export interface Owner { profileId: number; name: string; kind: 'person' | 'household' }

export function listOwners(db: Db): Owner[] {
  return db.prepare("SELECT id AS profileId, name, kind FROM profile ORDER BY kind = 'household', id").all() as Owner[]
}

// ---------- category groups ----------

export interface CategoryGroupRow { id: number; profileId: number; owner: string; name: string; kind: 'expense' | 'income'; group: string; overridden: boolean }

export function listCategoryGroups(db: Db): CategoryGroupRow[] {
  const rows = db.prepare(`SELECT c.id, c.profile_id AS profileId, p.name AS owner, c.name, c.kind, c.group_name AS groupName FROM category c JOIN profile p ON p.id = c.profile_id WHERE c.kind = 'expense' ORDER BY p.kind = 'household', p.id, c.name`).all() as { id: number; profileId: number; owner: string; name: string; kind: 'expense'; groupName: string | null }[]
  return rows.map((r) => ({ id: r.id, profileId: r.profileId, owner: r.owner, name: r.name, kind: r.kind, group: groupOf({ name: r.name, groupName: r.groupName }), overridden: !!r.groupName?.trim() }))
}

/** Pass null (or an empty text) to go back to the automatic group. */
export function setCategoryGroup(db: Db, categoryId: number, group: string | null): void {
  const c = db.prepare("SELECT kind FROM category WHERE id = ?").get(categoryId) as { kind: string } | undefined
  if (!c) throw new Error('That category no longer exists. Reload the page.')
  if (c.kind !== 'expense') throw new Error('Only spending categories have groups')
  const g = group?.trim() || null
  if (g && g.length > 60) throw new Error('The group name is too long')
  const before = listCategoryGroups(db)
  db.transaction(() => {
    db.prepare('UPDATE category SET group_name = ? WHERE id = ?').run(g, categoryId)
    // a group name already used by a household budget must keep working: refuse to orphan it silently
    const orphan = before.find((r) => r.id === categoryId)
    if (orphan) {
      const stillUsed = listCategoryGroups(db).some((r) => r.group === orphan.group)
      const inBudget = db.prepare('SELECT b.name FROM household_budget_group g JOIN household_budget b ON b.id = g.budget_id WHERE g.group_name = ?').get(orphan.group) as { name: string } | undefined
      if (!stillUsed && inBudget) throw new Error(`"${orphan.group}" is used by the household budget "${inBudget.name}". Edit that budget first.`)
    }
  })()
}

export function listGroupNames(db: Db): string[] {
  return [...new Set(listCategoryGroups(db).map((r) => r.group))].sort((a, b) => a.localeCompare(b))
}

// ---------- spending by owner / group ----------

interface Row { owner: number; date: string; cents: number; kind: 'income' | 'expense' | 'refund'; group: string | null }

function loadRows(db: Db): Row[] {
  const rows = db.prepare(`SELECT t.profile_id AS owner, t.posted_date AS date, t.amount_cents AS cents, t.kind, c.name AS cname, c.group_name AS gname FROM txn t LEFT JOIN category c ON c.id = t.category_id WHERE t.kind IN ('income','expense','refund')`).all() as { owner: number; date: string; cents: number; kind: 'income' | 'expense' | 'refund'; cname: string | null; gname: string | null }[]
  return rows.map((r) => ({ owner: r.owner, date: r.date, cents: r.cents, kind: r.kind, group: r.kind === 'income' ? null : r.cname ? groupOf({ name: r.cname, groupName: r.gname }) : 'Uncategorized' }))
}

export interface HouseholdOverview {
  month: string
  availableMonths: string[]
  owners: Owner[]
  combined: { incomeCents: number; expenseCents: number; netCents: number; savingsRate: number | null }
  perOwner: { profileId: number; name: string; kind: 'person' | 'household'; incomeCents: number; expenseCents: number; netCents: number }[]
  series: { month: string; incomeCents: number; expenseCents: number; netCents: number; perOwnerExpense: Record<number, number> }[]
  groups: { group: string; totalCents: number; perOwner: Record<number, number> }[]
  movement: { betweenUs: { fromId: number; from: string; to: string; sentCents: number }[]; sharedAccounts: { personId: number; person: string; putInCents: number; takenOutCents: number }[] }
  money: { assetsCents: number; owedCardsCents: number; otherDebtCents: number; perOwner: { profileId: number; name: string; assetsCents: number; owedCents: number }[] }
  pendingReview: number
  facts: string[]
}

export function getHouseholdOverview(db: Db, requestedMonth: string | undefined): HouseholdOverview | null {
  const owners = listOwners(db)
  const rows = loadRows(db)
  if (!rows.length) return null
  const months = [...new Set(rows.map((r) => monthKey(r.date)))].sort()
  const month = requestedMonth && months.includes(requestedMonth) ? requestedMonth : months[months.length - 1]!

  const perOwner = owners.map((o) => {
    let inc = 0, exp = 0
    for (const r of rows) if (r.owner === o.profileId && monthKey(r.date) === month) { if (r.kind === 'income') inc += r.cents; else exp += -r.cents }
    return { ...o, incomeCents: inc, expenseCents: exp, netCents: inc - exp }
  })
  const incomeCents = perOwner.reduce((s, o) => s + o.incomeCents, 0)
  const expenseCents = perOwner.reduce((s, o) => s + o.expenseCents, 0)

  const series = months.map((m) => {
    let inc = 0, exp = 0
    const per: Record<number, number> = {}
    for (const r of rows) {
      if (monthKey(r.date) !== m) continue
      if (r.kind === 'income') inc += r.cents
      else { exp += -r.cents; per[r.owner] = (per[r.owner] ?? 0) + -r.cents }
    }
    return { month: m, incomeCents: inc, expenseCents: exp, netCents: inc - exp, perOwnerExpense: per }
  })

  const g = new Map<string, { total: number; per: Record<number, number> }>()
  for (const r of rows) {
    if (r.kind === 'income' || monthKey(r.date) !== month) continue
    const e = g.get(r.group!) ?? { total: 0, per: {} }
    e.total += -r.cents
    e.per[r.owner] = (e.per[r.owner] ?? 0) + -r.cents
    g.set(r.group!, e)
  }
  const groups = [...g].filter(([, v]) => v.total !== 0).map(([group, v]) => ({ group, totalCents: v.total, perOwner: v.per })).sort((a, b) => b.totalCents - a.totalCents)

  // movement between you / into shared accounts (never income or spending)
  const persons = owners.filter((o) => o.kind === 'person')
  const hh = owners.find((o) => o.kind === 'household')
  const mv = db.prepare(`SELECT profile_id AS p, counterparty_profile_id AS c, SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END) AS sent, SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS got FROM txn WHERE kind = 'transfer' AND counterparty_profile_id IS NOT NULL AND posted_date BETWEEN ? AND ? GROUP BY profile_id, counterparty_profile_id`).all(monthStart(month), monthEnd(month)) as { p: number; c: number; sent: number; got: number }[]
  const betweenUs = persons.flatMap((from) => persons.filter((to) => to.profileId !== from.profileId).map((to) => ({ fromId: from.profileId, from: from.name, to: to.name, sentCents: mv.find((m) => m.p === from.profileId && m.c === to.profileId)?.sent ?? 0 }))).filter((x) => x.sentCents > 0)
  const sharedAccounts = persons.map((p) => ({ personId: p.profileId, person: p.name, putInCents: mv.find((m) => m.p === p.profileId && m.c === hh?.profileId)?.sent ?? 0, takenOutCents: mv.find((m) => m.p === p.profileId && m.c === hh?.profileId)?.got ?? 0 })).filter((x) => x.putInCents > 0 || x.takenOutCents > 0)

  // money: accounts and debts per owner (closed accounts are left out)
  const moneyPer = owners.map((o) => {
    let assets = 0, owed = 0
    for (const a of listAccounts(db, o.profileId)) {
      if (a.archived || a.valueCents === null) continue
      if (a.type === 'credit_card' || a.type === 'loan') owed += Math.max(0, -a.valueCents)
      else if (a.valueCents > 0) assets += a.valueCents
    }
    return { profileId: o.profileId, name: o.name, assetsCents: assets, owedCents: owed }
  })
  const other = (db.prepare('SELECT COALESCE(SUM(balance_cents),0) s FROM debt').get() as { s: number }).s

  const facts: string[] = []
  const label = monthLabel(month)
  if (expenseCents > 0) {
    facts.push(`Together you spent ${formatCents(expenseCents)} in ${label}: ${perOwner.filter((o) => o.expenseCents > 0).map((o) => `${o.name} ${formatCents(o.expenseCents)}`).join(', ')}.`)
    if (groups[0]) facts.push(`The biggest household category is ${groups[0].group} (${formatCents(groups[0].totalCents)}, ${Math.round((groups[0].totalCents / expenseCents) * 100)}% of spending).`)
  }
  if (incomeCents > 0 || expenseCents > 0) facts.push(incomeCents - expenseCents >= 0 ? `Together you kept ${formatCents(incomeCents - expenseCents)} of ${formatCents(incomeCents)} income.` : `Together you spent ${formatCents(expenseCents - incomeCents)} more than your recorded income of ${formatCents(incomeCents)}.`)
  for (const b of betweenUs) facts.push(`${b.from} sent ${b.to} ${formatCents(b.sentCents)}. That is movement between you, not spending.`)

  return {
    month, availableMonths: months, owners,
    combined: { incomeCents, expenseCents, netCents: incomeCents - expenseCents, savingsRate: incomeCents > 0 ? (incomeCents - expenseCents) / incomeCents : null },
    perOwner, series, groups, movement: { betweenUs, sharedAccounts },
    money: { assetsCents: moneyPer.reduce((s, o) => s + o.assetsCents, 0), owedCardsCents: moneyPer.reduce((s, o) => s + o.owedCents, 0), otherDebtCents: other, perOwner: moneyPer },
    pendingReview: (db.prepare('SELECT COUNT(*) n FROM txn WHERE review_reason IS NOT NULL').get() as { n: number }).n,
    facts
  }
}

// ---------- accounts across owners ----------

export interface HouseholdAccount extends AccountInfo { profileId: number; owner: string; ownerKind: 'person' | 'household' }

export function listHouseholdAccounts(db: Db): HouseholdAccount[] {
  return listOwners(db).flatMap((o) => listAccounts(db, o.profileId).map((a) => ({ ...a, profileId: o.profileId, owner: o.name, ownerKind: o.kind })))
}

// ---------- household budgets ----------

export interface HouseholdBudgetRow { id: number; name: string; monthlyCents: number; groups: string[] }

export function listHouseholdBudgets(db: Db): HouseholdBudgetRow[] {
  const rows = db.prepare('SELECT id, name, monthly_cents AS monthlyCents FROM household_budget ORDER BY id').all() as { id: number; name: string; monthlyCents: number }[]
  const groups = db.prepare('SELECT budget_id AS b, group_name AS g FROM household_budget_group ORDER BY group_name').all() as { b: number; g: string }[]
  return rows.map((r) => ({ ...r, groups: groups.filter((x) => x.b === r.id).map((x) => x.g) }))
}

function checkGroups(db: Db, groups: string[], exceptBudget?: number) {
  const known = new Set(listGroupNames(db))
  for (const g of groups) {
    if (!known.has(g)) throw new Error(`"${g}" is not a category group. Pick from the list.`)
    const taken = db.prepare('SELECT b.name FROM household_budget_group x JOIN household_budget b ON b.id = x.budget_id WHERE x.group_name = ? AND x.budget_id IS NOT ?').get(g, exceptBudget ?? null) as { name: string } | undefined
    if (taken) throw new Error(`"${g}" is already in the "${taken.name}" budget`)
  }
}

export function createHouseholdBudget(db: Db, name: string, monthlyCents: number, groups: string[]): number {
  const clean = name.trim()
  if (!clean) throw new Error('Give the budget a name')
  if (!Number.isInteger(monthlyCents) || monthlyCents < 0) throw new Error('The monthly amount cannot be negative')
  if (db.prepare('SELECT 1 FROM household_budget WHERE name = ? COLLATE NOCASE').get(clean)) throw new Error(`There is already a budget called "${clean}"`)
  return db.transaction(() => {
    checkGroups(db, groups)
    const id = Number(db.prepare('INSERT INTO household_budget (name, monthly_cents) VALUES (?,?)').run(clean, monthlyCents).lastInsertRowid)
    for (const g of groups) db.prepare('INSERT INTO household_budget_group (budget_id, group_name) VALUES (?,?)').run(id, g)
    return id
  })()
}

export function updateHouseholdBudget(db: Db, id: number, patch: { name?: string; monthlyCents?: number; groups?: string[] }): void {
  if (!db.prepare('SELECT 1 FROM household_budget WHERE id = ?').get(id)) throw new Error('That budget no longer exists. Reload the page.')
  db.transaction(() => {
    if (patch.name !== undefined) {
      const clean = patch.name.trim()
      if (!clean) throw new Error('Give the budget a name')
      if (db.prepare('SELECT 1 FROM household_budget WHERE name = ? COLLATE NOCASE AND id <> ?').get(clean, id)) throw new Error(`There is already a budget called "${clean}"`)
      db.prepare('UPDATE household_budget SET name = ? WHERE id = ?').run(clean, id)
    }
    if (patch.monthlyCents !== undefined) {
      if (!Number.isInteger(patch.monthlyCents) || patch.monthlyCents < 0) throw new Error('The monthly amount cannot be negative')
      db.prepare('UPDATE household_budget SET monthly_cents = ? WHERE id = ?').run(patch.monthlyCents, id)
    }
    if (patch.groups !== undefined) {
      checkGroups(db, patch.groups, id)
      db.prepare('DELETE FROM household_budget_group WHERE budget_id = ?').run(id)
      for (const g of patch.groups) db.prepare('INSERT INTO household_budget_group (budget_id, group_name) VALUES (?,?)').run(id, g)
    }
  })()
}

export function deleteHouseholdBudget(db: Db, id: number): void {
  if (!db.prepare('SELECT 1 FROM household_budget WHERE id = ?').get(id)) throw new Error('That budget no longer exists. Reload the page.')
  db.prepare('DELETE FROM household_budget WHERE id = ?').run(id)
}

export interface HouseholdBudgetLine extends BudgetStatus { id: number; name: string; groups: string[]; perOwner: { profileId: number; name: string; cents: number }[] }
export interface HouseholdBudgetReport {
  month: string
  lines: HouseholdBudgetLine[]
  unbudgeted: { group: string; cents: number }[]
  totals: { budgetCents: number; spentCents: number; remainingCents: number }
}

/** Spending (expenses minus refunds) by owner for a month, per category group. */
export function spendByGroup(db: Db, month: string): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>()
  const rows = db.prepare(`SELECT t.profile_id AS owner, t.amount_cents AS cents, c.name AS cname, c.group_name AS gname FROM txn t LEFT JOIN category c ON c.id = t.category_id WHERE t.kind IN ('expense','refund') AND t.posted_date BETWEEN ? AND ?`).all(monthStart(month), monthEnd(month)) as { owner: number; cents: number; cname: string | null; gname: string | null }[]
  for (const r of rows) {
    const g = r.cname ? groupOf({ name: r.cname, groupName: r.gname }) : 'Uncategorized'
    const m = out.get(g) ?? new Map<number, number>()
    m.set(r.owner, (m.get(r.owner) ?? 0) - r.cents)
    out.set(g, m)
  }
  return out
}

export function householdBudgetReport(db: Db, month: string): HouseholdBudgetReport {
  const owners = listOwners(db)
  const spend = spendByGroup(db, month)
  const budgets = listHouseholdBudgets(db)
  const covered = new Set<string>()
  const lines: HouseholdBudgetLine[] = budgets.map((b) => {
    const per = new Map<number, number>()
    for (const g of b.groups) {
      covered.add(g)
      for (const [o, c] of spend.get(g) ?? []) per.set(o, (per.get(o) ?? 0) + c)
    }
    const spent = [...per.values()].reduce((a, c) => a + c, 0)
    return { ...budgetStatus(b.monthlyCents, spent), id: b.id, name: b.name, groups: b.groups, perOwner: owners.map((o) => ({ profileId: o.profileId, name: o.name, cents: per.get(o.profileId) ?? 0 })).filter((x) => x.cents !== 0) }
  })
  const unbudgeted = [...spend].filter(([g]) => !covered.has(g)).map(([group, m]) => ({ group, cents: [...m.values()].reduce((a, c) => a + c, 0) })).filter((x) => x.cents !== 0).sort((a, b) => b.cents - a.cents)
  const budgetCents = lines.reduce((s, l) => s + l.budgetCents, 0)
  const spentCents = lines.reduce((s, l) => s + l.spentCents, 0)
  return { month, lines, unbudgeted, totals: { budgetCents, spentCents, remainingCents: budgetCents - spentCents } }
}

// ---------- goals: everyone's, labelled by owner, plus the household's own ----------

export interface HouseholdGoal extends GoalView { ownerId: number; owner: string; ownerKind: 'person' | 'household' }

export function listHouseholdGoals(db: Db, today: string): HouseholdGoal[] {
  return listOwners(db).flatMap((o) => listGoals(db, o.profileId, today).map((g) => ({ ...g, ownerId: o.profileId, owner: o.name, ownerKind: o.kind })))
}


export interface HouseholdBudgetSuggestions { months: string[]; suggestions: (BudgetSuggestion & { group: string })[] }

/** Like suggestBudgets, but across everyone's spending, by category group, skipping groups already in a household budget. */
export function suggestHouseholdBudgets(db: Db, today: string): HouseholdBudgetSuggestions {
  const window = lastCompleteMonths(today, 3)
  const withData = window.filter((m) => db.prepare(`SELECT 1 FROM txn WHERE kind IN ('expense','refund') AND posted_date BETWEEN ? AND ? LIMIT 1`).get(monthStart(m), monthEnd(m)))
  if (withData.length === 0) return { months: [], suggestions: [] }
  const perMonth = withData.map((m) => spendByGroup(db, m))
  const existing = listHouseholdBudgets(db)
  const covered = new Set(existing.flatMap((b) => b.groups))
  const taken = new Set(existing.map((b) => b.name.toLowerCase()))
  const groups = new Set(perMonth.flatMap((m) => [...m.keys()]))
  const items = [...groups].filter((g) => g !== 'Uncategorized' && !covered.has(g)).map((g) => ({
    key: g, name: taken.has(g.toLowerCase()) ? `${g} (suggested)` : g,
    monthlyCents: perMonth.map((m) => Math.max(0, [...(m.get(g)?.values() ?? [])].reduce((a, c) => a + c, 0)))
  }))
  return { months: withData, suggestions: suggestLimits(items).map((s) => ({ ...s, group: s.key })) }
}

export function createHouseholdBudgets(db: Db, items: { name: string; monthlyCents: number; groups: string[] }[]): number[] {
  return db.transaction(() => items.map((i) => createHouseholdBudget(db, i.name, i.monthlyCents, i.groups)))()
}

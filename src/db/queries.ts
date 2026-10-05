import type { Db } from './open'
import { accountValueCents } from './review'
import { rememberCategory } from './rules'
import { monthlyCostCents, annualCostCents, type Frequency } from '../core/recurring'
import { summarizeMonth, type MonthSummary } from '../core/summary'
import { generateInsights, type Insight } from '../core/insights'
import { addMonths, monthKey } from '../core/dates'
import { groupOf } from '../core/groups'
import { budgetReport } from './budgets'
import { listGoals } from './goals'

const localToday = () => new Date().toLocaleDateString('en-CA')

export interface Profile { id: number; slug: string; name: string }
export interface AccountInfo {
  id: number
  name: string
  type: string
  institution: string | null
  archived: boolean
  /** Money you have (assets) or, for cards, money owed as a negative number. null = investment never valued. */
  valueCents: number | null
  txnCount: number
  valuedAt: string | null
  /** Credit cards only: the limit the person entered, if any. */
  creditLimitCents: number | null
}
export interface CategoryInfo { id: number; name: string; kind: 'expense' | 'income' }

export interface TxnFilter {
  text?: string
  accountId?: number
  categoryId?: number
  kind?: string
  from?: string
  to?: string
  /** compared against the absolute amount */
  minCents?: number
  maxCents?: number
  reviewOnly?: boolean
  /** Household view: only this person's (or the shared) rows. */
  personId?: number
  /** Household view: only categories in this group (e.g. "Dining"), across everyone. */
  groupName?: string
  sort?: 'date' | 'amount' | 'category' | 'merchant'
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}
export interface TxnRow {
  id: number
  date: string
  description: string
  amountCents: number
  accountId: number
  account: string
  categoryId: number | null
  category: string | null
  kind: string
  reviewReason: string | null
  notes: string | null
  source: string
  transferGroup: string | null
  profileId: number
  person: string
  /** Money between you and the other person / a shared account: the name of the other side. */
  counterparty: string | null
  /** Set for cash tips received in a foreign currency (amountCents is the converted home-currency value). */
  currency: string | null
  originalCents: number | null
  fxRate: number | null
}

/** The people (not the household). */
export function listProfiles(db: Db): Profile[] {
  return db.prepare("SELECT id, slug, name FROM profile WHERE kind = 'person' ORDER BY id").all() as Profile[]
}

/** The pseudo-profile that owns shared accounts, or null when the setup has no shared household (single and couple modes). */
export function findHouseholdProfile(db: Db): Profile | null {
  return (db.prepare("SELECT id, slug, name FROM profile WHERE kind = 'household'").get() as Profile | undefined) ?? null
}

export function getHouseholdProfile(db: Db): Profile {
  const p = findHouseholdProfile(db)
  if (!p) throw new Error('This setup has no shared household.')
  return p
}

export function listAccounts(db: Db, profileId: number): AccountInfo[] {
  const rows = db.prepare('SELECT id, name, type, institution, archived, credit_limit_cents AS creditLimitCents FROM account WHERE profile_id = ? ORDER BY archived, id').all(profileId) as { id: number; name: string; type: string; institution: string | null; creditLimitCents: number | null; archived: number }[]
  return rows.map((a) => {
    const n = (db.prepare('SELECT COUNT(*) n FROM txn WHERE account_id = ?').get(a.id) as { n: number }).n
    const val = db.prepare('SELECT as_of FROM account_valuation WHERE account_id = ? ORDER BY as_of DESC LIMIT 1').get(a.id) as { as_of: string } | undefined
    return { id: a.id, name: a.name, type: a.type, institution: a.institution, archived: !!a.archived, valueCents: accountValueCents(db, a.id), txnCount: n, valuedAt: val?.as_of ?? null, creditLimitCents: a.creditLimitCents }
  })
}

export function listCategories(db: Db, profileId: number): CategoryInfo[] {
  return db.prepare('SELECT id, name, kind FROM category WHERE profile_id = ? ORDER BY kind, name').all(profileId) as CategoryInfo[]
}

/** Creates a category for this person, or returns the existing one with the same name (case-insensitive). */
export function createCategory(db: Db, profileId: number, name: string, kind: 'expense' | 'income'): CategoryInfo {
  const clean = name.trim().replace(/\s+/g, ' ')
  if (!clean) throw new Error('Category name cannot be empty')
  if (clean.length > 60) throw new Error('Category name is too long')
  const existing = db.prepare('SELECT id, name, kind FROM category WHERE profile_id = ? AND kind = ? AND name = ? COLLATE NOCASE').get(profileId, kind, clean) as CategoryInfo | undefined
  if (existing) return existing
  const id = Number(db.prepare('INSERT INTO category (profile_id, name, kind) VALUES (?,?,?)').run(profileId, clean, kind).lastInsertRowid)
  return { id, name: clean, kind }
}

const SORT_SQL: Record<NonNullable<TxnFilter['sort']>, string> = {
  date: 't.posted_date',
  amount: 'ABS(t.amount_cents)',
  category: 'c.name',
  merchant: 't.description COLLATE NOCASE'
}

export function queryTxns(db: Db, profileIds: number | number[], f: TxnFilter = {}): { rows: TxnRow[]; total: number; sumCents: number } {
  const ids = Array.isArray(profileIds) ? profileIds : [profileIds]
  if (ids.length === 0) return { rows: [], total: 0, sumCents: 0 }
  const where: string[] = [`t.profile_id IN (${ids.map(() => '?').join(',')})`]
  const params: unknown[] = [...ids]
  const named: Record<string, unknown> = {}
  if (f.text) { where.push('(t.description LIKE @text OR t.notes LIKE @text)'); named.text = `%${f.text}%` }
  if (f.accountId) { where.push('t.account_id = @acc'); named.acc = f.accountId }
  if (f.personId) { where.push('t.profile_id = @person'); named.person = f.personId }
  if (f.categoryId) { where.push('t.category_id = @cat'); named.cat = f.categoryId }
  if (f.groupName) {
    const cats = db.prepare(`SELECT id, name, group_name AS groupName FROM category WHERE profile_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: number; name: string; groupName: string | null }[]
    const inGroup = cats.filter((c) => groupOf(c) === f.groupName).map((c) => c.id)
    where.push(inGroup.length ? `t.category_id IN (${inGroup.join(',')})` : '0')
  }
  if (f.kind) { where.push('t.kind = @kind'); named.kind = f.kind }
  if (f.from) { where.push('t.posted_date >= @from'); named.from = f.from }
  if (f.to) { where.push('t.posted_date <= @to'); named.to = f.to }
  if (f.minCents !== undefined) { where.push('ABS(t.amount_cents) >= @min'); named.min = f.minCents }
  if (f.maxCents !== undefined) { where.push('ABS(t.amount_cents) <= @max'); named.max = f.maxCents }
  if (f.reviewOnly) where.push('t.review_reason IS NOT NULL')
  const w = where.join(' AND ')
  const order = `${SORT_SQL[f.sort ?? 'date']} ${f.dir === 'asc' ? 'ASC' : 'DESC'}, t.id ${f.dir === 'asc' ? 'ASC' : 'DESC'}`
  const from = 'FROM txn t JOIN account a ON a.id = t.account_id JOIN profile pr ON pr.id = t.profile_id LEFT JOIN profile cp ON cp.id = t.counterparty_profile_id LEFT JOIN category c ON c.id = t.category_id'
  // positional placeholders for the profile list and named ones for the rest can not be mixed, so inline the (integer) ids
  const inlineW = w.replace(/\?/g, () => String(Number(params.shift())))
  const rows = db
    .prepare(
      `SELECT t.id, t.posted_date AS date, t.description, t.amount_cents AS amountCents, t.account_id AS accountId, a.name AS account,
              t.category_id AS categoryId, c.name AS category, t.kind, t.review_reason AS reviewReason, t.notes, t.source, t.transfer_group AS transferGroup,
              t.profile_id AS profileId, pr.name AS person, cp.name AS counterparty,
              t.currency, t.original_cents AS originalCents, t.fx_rate AS fxRate
       ${from} WHERE ${inlineW} ORDER BY ${order} LIMIT @limit OFFSET @offset`
    )
    .all({ ...named, limit: f.limit ?? 200, offset: f.offset ?? 0 }) as TxnRow[]
  const agg = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(t.amount_cents),0) s ${from} WHERE ${inlineW}`).get(named) as { n: number; s: number }
  return { rows, total: agg.n, sumCents: agg.s }
}

/** Change the category of a spending/income row. Kind is untouched; the category must match it. */
export function setTxnCategory(db: Db, txnId: number, categoryId: number): void {
  const t = db.prepare('SELECT profile_id, kind FROM txn WHERE id = ?').get(txnId) as { profile_id: number; kind: string } | undefined
  const c = db.prepare('SELECT profile_id, kind FROM category WHERE id = ?').get(categoryId) as { profile_id: number; kind: string } | undefined
  if (!t || !c) throw new Error('That transaction or category no longer exists. Reload the page.')
  if (t.profile_id !== c.profile_id) throw new Error('That category belongs to someone else. Pick one of your own.')
  const need = t.kind === 'income' ? 'income' : t.kind === 'expense' || t.kind === 'refund' ? 'expense' : null
  if (!need) throw new Error('Only income, expense and refund rows have a category; resolve it in the review queue first')
  if (c.kind !== need) throw new Error(`This row needs a ${need} category`)
  db.transaction(() => {
    db.prepare('UPDATE txn SET category_id = ? WHERE id = ?').run(categoryId, txnId)
    // remember the correction for future imports (not for e-transfers)
    const d = db.prepare('SELECT description, description_raw AS raw FROM txn WHERE id = ?').get(txnId) as { description: string; raw: string | null }
    rememberCategory(db, t.profile_id, d.raw ?? d.description, d.description, categoryId)
  })()
}

export interface RecurringRow {
  id: number
  name: string
  direction: string
  account: string | null
  accountId: number | null
  paidWith: string | null
  amountCents: number
  frequency: Frequency
  status: string
  countsInBudget: boolean
  monthlyCents: number
  annualCents: number
  lastCharged: string | null
  usualTiming: string | null
  notes: string | null
}

export function listRecurring(db: Db, profileId: number): RecurringRow[] {
  const rows = db.prepare(`SELECT r.*, a.name AS account FROM recurring r LEFT JOIN account a ON a.id = r.account_id WHERE r.profile_id = ? ORDER BY r.direction DESC, r.status = 'cancelled', r.id`).all(profileId) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as number, name: r.name as string, direction: r.direction as string, account: (r.account as string) ?? null, accountId: (r.account_id as number) ?? null, paidWith: (r.paid_with as string) ?? null,
    amountCents: r.amount_cents as number, frequency: r.frequency as Frequency, status: r.status as string, countsInBudget: !!r.counts_in_budget,
    monthlyCents: monthlyCostCents(r.amount_cents as number, r.frequency as Frequency), annualCents: annualCostCents(r.amount_cents as number, r.frequency as Frequency),
    lastCharged: (r.last_charged as string) ?? null, usualTiming: (r.usual_timing as string) ?? null, notes: (r.notes as string) ?? null
  }))
}

/** Active bills paid from the Cash wallet (never on a bank statement). Matches by account, not by name. */
export function listCashBills(db: Db, profileId: number): RecurringRow[] {
  const ids = new Set((db.prepare("SELECT id FROM account WHERE profile_id = ? AND type = 'cash'").all(profileId) as { id: number }[]).map((r) => r.id))
  return listRecurring(db, profileId).filter((r) => r.direction === 'expense' && r.status !== 'cancelled' && r.accountId !== null && ids.has(r.accountId))
}

export interface Dashboard {
  month: string
  availableMonths: string[]
  summary: MonthSummary
  previous: MonthSummary | null
  lastYear: MonthSummary | null
  average: { months: number; incomeCents: number; expenseCents: number; netCents: number } | null
  series: MonthSummary[]
  largestExpenses: { id: number; date: string; description: string; category: string | null; cents: number }[]
  assetsCents: number
  owedCardsCents: number
  otherDebtCents: number
  recurring: { monthlyCents: number; annualCents: number; pctOfIncome: number | null; count: number }
  budget: { budgetCents: number; spentCents: number; remainingCents: number; overCount: number; count: number } | null
  insights: Insight[]
  reviewCount: number
}

export function getDashboard(db: Db, profileId: number, requestedMonth?: string, today: string = localToday()): Dashboard | null {
  const rows = db
    .prepare(`SELECT t.id, t.posted_date AS date, t.amount_cents AS amountCents, t.kind, c.name AS category, t.description FROM txn t LEFT JOIN category c ON c.id = t.category_id WHERE t.profile_id = ? AND t.kind IN ('income','expense','refund')`)
    .all(profileId) as { id: number; date: string; amountCents: number; kind: 'income' | 'expense' | 'refund'; category: string | null; description: string }[]
  if (!rows.length) return null
  const months = [...new Set(rows.map((r) => monthKey(r.date)))].sort()
  const month = requestedMonth && months.includes(requestedMonth) ? requestedMonth : months[months.length - 1]!
  const series = months.map((m) => summarizeMonth(rows, m))
  const get = (m: string) => series.find((s) => s.month === m) ?? null
  const prior = series.filter((s) => s.month < month).slice(-12)
  const accounts = listAccounts(db, profileId).filter((a) => !a.archived)
  let assets = 0
  let owed = 0
  for (const a of accounts) {
    if (a.valueCents === null) continue
    if (a.type === 'credit_card') owed += Math.max(0, -a.valueCents)
    else if (a.valueCents > 0) assets += a.valueCents
  }
  const other = (db.prepare('SELECT COALESCE(SUM(balance_cents),0) s FROM debt WHERE profile_id = ?').get(profileId) as { s: number }).s
  const rec = listRecurring(db, profileId).filter((r) => r.direction === 'expense' && r.countsInBudget && r.status !== 'cancelled')
  const recMonthly = rec.reduce((a, r) => a + r.monthlyCents, 0)
  const summary = get(month)!
  const br = budgetReport(db, profileId, month, today)
  const goals = listGoals(db, profileId, today)
  const incomeBase = prior.length ? prior.reduce((a, s) => a + s.incomeCents, 0) / prior.length : summary.incomeCents
  return {
    month,
    availableMonths: months,
    summary,
    previous: get(addMonths(month, -1)),
    lastYear: get(addMonths(month, -12)),
    average: prior.length ? { months: prior.length, incomeCents: Math.round(prior.reduce((a, s) => a + s.incomeCents, 0) / prior.length), expenseCents: Math.round(prior.reduce((a, s) => a + s.expenseCents, 0) / prior.length), netCents: Math.round(prior.reduce((a, s) => a + s.netCents, 0) / prior.length) } : null,
    series,
    largestExpenses: rows.filter((r) => r.kind === 'expense' && monthKey(r.date) === month).sort((a, b) => a.amountCents - b.amountCents).slice(0, 6).map((r) => ({ id: r.id, date: r.date, description: r.description, category: r.category, cents: -r.amountCents })),
    assetsCents: assets,
    owedCardsCents: owed,
    otherDebtCents: other,
    recurring: { monthlyCents: recMonthly, annualCents: recMonthly * 12, pctOfIncome: incomeBase > 0 ? recMonthly / incomeBase : null, count: rec.length },
    budget: br.lines.length ? { budgetCents: br.totals.budgetCents, spentCents: br.totals.spentCents, remainingCents: br.totals.remainingCents, overCount: br.lines.filter((l) => l.state === 'over').length, count: br.lines.length } : null,
    insights: generateInsights({ cards: listAccounts(db, profileId).filter((a) => a.type === 'credit_card' && !a.archived && (a.creditLimitCents ?? 0) > 0).map((a) => ({ name: a.name, owedCents: Math.max(0, -(a.valueCents ?? 0)), limitCents: a.creditLimitCents! })), month, series, txns: rows.map((r) => ({ ...r })), recurringMonthlyCents: recMonthly, budgets: br.lines.map((l) => ({ name: l.name, budgetCents: l.budgetCents, spentCents: l.spentCents, projectedCents: l.projectedCents })), goals: goals.map((g) => ({ name: g.name, deadline: g.deadline, plannedMonthlyCents: g.plannedMonthlyCents, progress: g.progress })) }),
    reviewCount: (db.prepare('SELECT COUNT(*) n FROM txn WHERE profile_id = ? AND review_reason IS NOT NULL').get(profileId) as { n: number }).n
  }
}

export interface DebtRow { id: number; name: string; balanceCents: number; asOf: string; notes: string | null }
export function listDebts(db: Db, profileId: number): DebtRow[] {
  return db.prepare('SELECT id, name, balance_cents AS balanceCents, as_of AS asOf, notes FROM debt WHERE profile_id = ? ORDER BY balance_cents DESC').all(profileId) as DebtRow[]
}

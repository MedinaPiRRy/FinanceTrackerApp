// The Taxes & interest page: what was paid and what was received in taxes and in interest, by month and year, with the transactions behind each figure.
import type { Db } from './open'
import { classifyCost, guessPurpose, type CostSide, type CostWhy, type Purpose } from '../core/costs'
import { pairReversals, reversedIds } from '../core/offsets'
import { addDays } from '../core/dates'

export type CostKindName = 'tax' | 'interest'

export interface CostLine {
  id: number
  accountId: number
  account: string
  profileId: number
  date: string
  description: string
  /** The category as shown (Main › Sub), and the main category's id (what a group is made of). */
  category: string | null
  categoryId: number | null
  /** The amount for its side: paid is positive (a refund is negative); received is positive. */
  cents: number
  kind: CostKindName
  side: CostSide
  why: CostWhy
  /** What the person chose for this one payment, if anything. */
  marked: Purpose | null
}

export interface CostGroup { id: number | null; name: string; paidCents: number; receivedCents: number }
export interface CostFigures { paidCents: number; receivedCents: number; byCategory: CostGroup[]; byAccount: CostGroup[] }
export interface CostsReport {
  year: number
  /** Years that have any transactions, newest first (always includes the one asked for). */
  years: number[]
  months: { month: string; taxCents: number; taxReceivedCents: number; interestCents: number; interestReceivedCents: number }[]
  tax: CostFigures
  interest: CostFigures
  /** What the person took out of this page: whole accounts, and the number of single payments left out (see `costLines` with kind "removed"). */
  removed: { accounts: { id: number; name: string }[]; payments: number }
  // totals kept at the top level for callers that only want the headline numbers
  taxCents: number
  interestCents: number
}

interface Raw { id: number; profileId: number; accountId: number; account: string; excluded: number; date: string; cents: number; kind: string; description: string; category: string | null; categoryId: number | null; purpose: string | null; parentName: string | null; parentPurpose: string | null; rootId: number | null; marked: string | null }

/** Every transaction of the year (with a week either side, so a charge and its rebate can find each other), and what each one counts as. */
function classifyYear(db: Db, profileIds: number[], year: number): { lines: CostLine[]; removedRows: CostLine[] } {
  if (profileIds.length === 0) return { lines: [], removedRows: [] }
  const marks = profileIds.map(() => '?').join(',')
  const rows = db.prepare(`SELECT t.id, t.profile_id AS profileId, t.account_id AS accountId, a.name AS account, a.costs_excluded AS excluded, t.posted_date AS date, t.amount_cents AS cents, t.kind,
      COALESCE(t.description_raw, t.description) AS description, c.name AS category, t.category_id AS categoryId, c.purpose AS purpose, pc.name AS parentName, pc.purpose AS parentPurpose,
      COALESCE(c.parent_id, c.id) AS rootId, t.cost_purpose AS marked
    FROM txn t JOIN account a ON a.id = t.account_id LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category pc ON pc.id = c.parent_id
    WHERE t.profile_id IN (${marks}) AND t.kind IN ('expense','refund','income') AND t.posted_date BETWEEN ? AND ?`).all(...profileIds, addDays(`${year}-01-01`, -7), addDays(`${year}-12-31`, 7)) as Raw[]
  // a charge the bank paid straight back (a fee and its rebate) cancels out
  const reversed = reversedIds(pairReversals(rows.filter((r) => r.kind !== 'income').map((r) => ({ id: r.id, date: r.date, amountCents: r.cents, kind: r.kind, category: r.categoryId === null ? null : String(r.categoryId), accountId: r.accountId }))))
  const lines: CostLine[] = []
  const removedRows: CostLine[] = []
  for (const r of rows) {
    if (!r.date.startsWith(`${year}-`) || reversed.has(r.id)) continue
    // a subcategory takes its own setting, else its main category's, else a guess from the main category's name
    const own = (r.purpose ?? r.parentPurpose) as Purpose | null
    const marked = (r.marked as Purpose | null) ?? null
    const cls = classifyCost({ kind: r.kind, amountCents: r.cents, description: r.description, categoryPurpose: own, categoryName: r.parentName ?? r.category, markedPurpose: marked, accountExcluded: r.excluded === 1 })
    const base = { id: r.id, accountId: r.accountId, account: r.account, profileId: r.profileId, date: r.date, description: r.description, category: r.parentName ? `${r.parentName} › ${r.category}` : r.category, categoryId: r.rootId, marked }
    if (cls) lines.push({ ...base, kind: cls.kind, side: cls.side, why: cls.why, cents: cls.side === 'paid' ? -r.cents : r.cents })
    else if (marked === 'none') removedRows.push({ ...base, kind: 'tax', side: r.cents < 0 ? 'paid' : 'received', why: 'marked', cents: r.cents < 0 ? -r.cents : r.cents })
  }
  return { lines, removedRows }
}

function figures(lines: CostLine[]): CostFigures {
  const cat = new Map<string, CostGroup>(), acc = new Map<string, CostGroup>()
  let paid = 0, received = 0
  const add = (m: Map<string, CostGroup>, key: string, g: Omit<CostGroup, 'paidCents' | 'receivedCents'>, l: CostLine) => {
    const x = m.get(key) ?? m.set(key, { ...g, paidCents: 0, receivedCents: 0 }).get(key)!
    if (l.side === 'paid') x.paidCents += l.cents; else x.receivedCents += l.cents
  }
  for (const l of lines) {
    if (l.side === 'paid') paid += l.cents; else received += l.cents
    add(cat, String(l.categoryId), { id: l.categoryId, name: l.category?.split(' › ')[0] ?? 'No category' }, l)
    add(acc, String(l.accountId), { id: l.accountId, name: l.account }, l)
  }
  const sorted = (m: Map<string, CostGroup>) => [...m.values()].filter((g) => g.paidCents !== 0 || g.receivedCents !== 0).sort((a, b) => (b.paidCents + b.receivedCents) - (a.paidCents + a.receivedCents))
  return { paidCents: paid, receivedCents: received, byCategory: sorted(cat), byAccount: sorted(acc) }
}

export function costsReport(db: Db, profileIds: number[], year: number): CostsReport {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error('Choose a year.')
  const months = Array.from({ length: 12 }, (_, i) => ({ month: `${year}-${String(i + 1).padStart(2, '0')}`, taxCents: 0, taxReceivedCents: 0, interestCents: 0, interestReceivedCents: 0 }))
  const empty: CostsReport = { year, years: [year], months, tax: { paidCents: 0, receivedCents: 0, byCategory: [], byAccount: [] }, interest: { paidCents: 0, receivedCents: 0, byCategory: [], byAccount: [] }, removed: { accounts: [], payments: 0 }, taxCents: 0, interestCents: 0 }
  if (profileIds.length === 0) return empty
  const marks = profileIds.map(() => '?').join(',')
  const years = [...new Set((db.prepare(`SELECT DISTINCT substr(posted_date, 1, 4) AS y FROM txn WHERE profile_id IN (${marks}) AND kind IN ('expense','refund','income')`).all(...profileIds) as { y: string }[]).map((r) => Number(r.y)).concat(year))].sort((a, b) => b - a)
  const { lines, removedRows } = classifyYear(db, profileIds, year)
  for (const l of lines) {
    const m = months.find((x) => x.month === l.date.slice(0, 7))!
    if (l.kind === 'tax') { if (l.side === 'paid') m.taxCents += l.cents; else m.taxReceivedCents += l.cents }
    else if (l.side === 'paid') m.interestCents += l.cents; else m.interestReceivedCents += l.cents
  }
  const tax = figures(lines.filter((l) => l.kind === 'tax')), interest = figures(lines.filter((l) => l.kind === 'interest'))
  const accounts = db.prepare(`SELECT id, name FROM account WHERE profile_id IN (${marks}) AND costs_excluded = 1 ORDER BY name`).all(...profileIds) as { id: number; name: string }[]
  const payments = (db.prepare(`SELECT COUNT(*) n FROM txn WHERE profile_id IN (${marks}) AND cost_purpose = 'none'`).get(...profileIds) as { n: number }).n
  return { year, years, months, tax, interest, removed: { accounts, payments }, taxCents: tax.paidCents, interestCents: interest.paidCents }
}

export interface CostLinesQuery {
  /** "tax" or "interest" lists what counts; "removed" lists the payments the person left out (so they can be counted again). */
  kind: CostKindName | 'removed'
  side?: CostSide
  /** Only payments in this main category (and its subcategories), or in this account. */
  categoryId?: number | null
  accountId?: number
  offset?: number
  limit?: number
}

/** The transactions behind a figure, newest first, a page at a time. */
export function costLines(db: Db, profileIds: number[], year: number, q: CostLinesQuery): { total: number; paidCents: number; receivedCents: number; rows: CostLine[] } {
  if (!q || typeof q !== 'object' || !['tax', 'interest', 'removed'].includes(q.kind)) throw new Error('Choose taxes, interest, or the payments left out.')
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error('Choose a year.')
  const { lines, removedRows } = classifyYear(db, profileIds, year)
  let list = q.kind === 'removed' ? removedRows : lines.filter((l) => l.kind === q.kind)
  if (q.side) list = list.filter((l) => l.side === q.side)
  if (q.categoryId !== undefined) list = list.filter((l) => l.categoryId === q.categoryId)
  if (q.accountId !== undefined) list = list.filter((l) => l.accountId === q.accountId)
  list.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
  const paidCents = list.reduce((s, l) => s + (l.side === 'paid' ? l.cents : 0), 0)
  const receivedCents = list.reduce((s, l) => s + (l.side === 'received' ? l.cents : 0), 0)
  const offset = Math.max(0, q.offset ?? 0), limit = Math.min(500, Math.max(1, q.limit ?? 50))
  return { total: list.length, paidCents, receivedCents, rows: list.slice(offset, offset + limit) }
}

export { guessPurpose }

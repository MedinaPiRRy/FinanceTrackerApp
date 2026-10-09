// The Taxes & interest page: what was paid in taxes and in interest, by month and by year, with the transactions behind it.
import type { Db } from './open'
import { costKind, guessPurpose, type Purpose } from '../core/costs'
import { pairReversals, reversedIds } from '../core/offsets'

export interface CostLine { id: number; accountId: number; profileId: number; date: string; description: string; category: string | null; /** Paid: positive. A refund or reversal: negative. */ cents: number }
export interface CostsReport {
  year: number
  /** Years that have any spending, newest first (always includes the one asked for). */
  years: number[]
  months: { month: string; taxCents: number; interestCents: number }[]
  taxCents: number
  interestCents: number
  /** What the totals are made of, biggest first (a category for taxes; the account or category for interest). */
  taxBy: { name: string; cents: number }[]
  interestBy: { name: string; cents: number }[]
  taxLines: CostLine[]
  interestLines: CostLine[]
  /** Lines beyond the cap (the totals still count them). */
  moreTax: number
  moreInterest: number
}

const CAP = 200

export function costsReport(db: Db, profileIds: number[], year: number): CostsReport {
  const empty: CostsReport = { year, years: [year], months: Array.from({ length: 12 }, (_, i) => ({ month: `${year}-${String(i + 1).padStart(2, '0')}`, taxCents: 0, interestCents: 0 })), taxCents: 0, interestCents: 0, taxBy: [], interestBy: [], taxLines: [], interestLines: [], moreTax: 0, moreInterest: 0 }
  if (profileIds.length === 0) return empty
  const marks = profileIds.map(() => '?').join(',')
  const rows = db.prepare(`SELECT t.id, t.profile_id AS profileId, t.account_id AS accountId, t.posted_date AS date, t.amount_cents AS cents, t.kind, COALESCE(t.description_raw, t.description) AS description,
      c.name AS category, c.purpose AS purpose, pc.name AS parentName, pc.purpose AS parentPurpose, t.category_id AS categoryId, a.name AS account
    FROM txn t JOIN account a ON a.id = t.account_id LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category pc ON pc.id = c.parent_id
    WHERE t.profile_id IN (${marks}) AND t.kind IN ('expense','refund')`).all(...profileIds) as
    { id: number; profileId: number; accountId: number; date: string; cents: number; kind: string; description: string; category: string | null; purpose: string | null; parentName: string | null; parentPurpose: string | null; categoryId: number | null; account: string }[]
  const years = [...new Set(rows.map((r) => Number(r.date.slice(0, 4))).concat(year))].sort((a, b) => b - a)

  // a charge the bank paid straight back (a fee and its rebate) cancels out
  const reversed = reversedIds(pairReversals(rows.map((r) => ({ id: r.id, date: r.date, amountCents: r.cents, kind: r.kind, category: r.categoryId === null ? null : String(r.categoryId), accountId: r.accountId }))))

  const out: CostsReport = { ...empty, years }
  const taxBy = new Map<string, number>(), interestBy = new Map<string, number>()
  const tax: CostLine[] = [], interest: CostLine[] = []
  for (const r of rows) {
    if (!r.date.startsWith(`${year}-`) || reversed.has(r.id)) continue
    // a subcategory takes its own setting, else its main category's, else a guess from the main category's name
    const own = (r.purpose ?? r.parentPurpose) as Purpose | null
    const kind = costKind({ kind: r.kind, amountCents: r.cents, description: r.description, categoryPurpose: own, categoryName: r.parentName ?? r.category })
    if (kind === null) continue
    const spent = -r.cents
    const m = out.months.find((x) => x.month === r.date.slice(0, 7))!
    const line: CostLine = { id: r.id, accountId: r.accountId, profileId: r.profileId, date: r.date, description: r.description, category: r.category, cents: spent }
    if (kind === 'tax') { m.taxCents += spent; out.taxCents += spent; taxBy.set(r.parentName ?? r.category ?? 'No category', (taxBy.get(r.parentName ?? r.category ?? 'No category') ?? 0) + spent); tax.push(line) }
    else { m.interestCents += spent; out.interestCents += spent; interestBy.set(r.account, (interestBy.get(r.account) ?? 0) + spent); interest.push(line) }
  }
  const byDateDesc = (a: CostLine, b: CostLine) => b.date.localeCompare(a.date) || b.id - a.id
  const sorted = (m: Map<string, number>) => [...m].map(([name, cents]) => ({ name, cents })).filter((x) => x.cents !== 0).sort((a, b) => b.cents - a.cents)
  out.taxBy = sorted(taxBy); out.interestBy = sorted(interestBy)
  out.taxLines = tax.sort(byDateDesc).slice(0, CAP); out.interestLines = interest.sort(byDateDesc).slice(0, CAP)
  out.moreTax = Math.max(0, tax.length - CAP); out.moreInterest = Math.max(0, interest.length - CAP)
  return out
}

export { guessPurpose }

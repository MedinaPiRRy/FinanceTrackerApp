// What counts toward a goal: the transactions behind its progress, a page at a time.
// Savings goals that track an account count that account's transactions (money in raises it, money out lowers it).
// Spending goals count the category and its subcategories. Payoff goals (and the rows of the debt payoff planner) count the
// payments made on the card or loan: money paid into the card, and payments linked to the loan.
import type { Db } from './open'
import type { DebtItem } from './goals'

export interface GoalTxn { id: number; accountId: number; account: string; date: string; description: string; category: string | null; kind: string; amountCents: number }
export interface GoalDetail {
  title: string
  /** One sentence saying what is counted. */
  explain: string
  /** How many transactions count, and how much has gone toward the goal through them. */
  count: number
  countedCents: number
  /** Money in and money out, for an account goal (counted is the difference). */
  inCents: number | null
  outCents: number | null
  /** Money entered by hand (savings goals, and spending goals' "saved separately"). */
  manualCents: number
  rows: GoalTxn[]
  /** Filters that open the same list on the Transactions page, when one filter describes it. */
  openIn: { accountId?: number; categoryId?: number; from?: string } | null
}

interface Where { sql: string; params: unknown[] }

const SELECT = `SELECT t.id, t.account_id AS accountId, a.name AS account, t.posted_date AS date, t.description, COALESCE(pc.name || ' › ' || c.name, c.name) AS category, t.kind, t.amount_cents AS amountCents
  FROM txn t JOIN account a ON a.id = t.account_id LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category pc ON pc.id = c.parent_id`

function page(db: Db, w: Where, offset: number, limit: number) {
  const rows = db.prepare(`${SELECT} WHERE ${w.sql} ORDER BY t.posted_date DESC, t.id DESC LIMIT ? OFFSET ?`).all(...w.params, limit, offset) as GoalTxn[]
  const s = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END), 0) pos, COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END), 0) neg, COALESCE(SUM(t.amount_cents), 0) net FROM txn t WHERE ${w.sql}`).get(...w.params) as { n: number; pos: number; neg: number; net: number }
  return { rows, ...s }
}

const NOTHING: Where = { sql: '0', params: [] }

/** Payments on cards and loans: money paid into a card (not a refund), and the payments linked to a loan, from `since` on. */
function payoffWhere(items: DebtItem[], since: string | null): Where {
  const parts: string[] = []
  const params: unknown[] = []
  for (const it of items) {
    if (it.accountId) { parts.push(`(t.account_id = ? AND t.amount_cents > 0 AND t.kind <> 'refund'${since ? ' AND t.posted_date >= ?' : ''})`); params.push(it.accountId); if (since) params.push(since) }
    else if (it.debtId) { parts.push(`(t.id IN (SELECT txn_id FROM debt_payment WHERE debt_id = ?)${since ? ' AND t.posted_date >= ?' : ''})`); params.push(it.debtId); if (since) params.push(since) }
  }
  return parts.length ? { sql: `(${parts.join(' OR ')})`, params } : NOTHING
}

export function goalDetail(db: Db, profileId: number, goalId: number, offset = 0, limit = 50): GoalDetail {
  const g = db.prepare("SELECT *, date(created_at, 'localtime') AS created_local FROM goal WHERE id = ?").get(goalId) as { id: number; profile_id: number; name: string; kind: string; manual_cents: number; account_id: number | null; category_id: number | null; created_at: string; created_local: string } | undefined
  const household = (db.prepare('SELECT kind FROM profile WHERE id = ?').get(profileId) as { kind: string } | undefined)?.kind === 'household'
  if (!g || (g.profile_id !== profileId && !household)) throw new Error('That goal no longer exists. Reload the page.')
  const base = { title: g.name, manualCents: g.manual_cents }
  if (g.kind === 'manual') return { ...base, explain: 'This goal is money you add by hand, so no transactions count toward it. Change the amount saved by editing the goal.', count: 0, countedCents: g.manual_cents, inCents: null, outCents: null, rows: [], openIn: null }
  if (g.kind === 'account') {
    const w: Where = { sql: 't.account_id = ?', params: [g.account_id] }
    const p = page(db, w, offset, limit)
    return { ...base, explain: 'Every transaction in the account this goal tracks. Money in raises the goal; money out lowers it.', count: p.n, countedCents: p.net, inCents: p.pos, outCents: p.neg, rows: p.rows, openIn: g.account_id ? { accountId: g.account_id } : null }
  }
  if (g.kind === 'category') {
    const w: Where = { sql: `t.category_id IN (SELECT id FROM category WHERE id = ? OR parent_id = ?) AND t.kind IN ('expense','refund')`, params: [g.category_id, g.category_id] }
    const p = page(db, w, offset, limit)
    return { ...base, explain: 'Spending in the category (and its subcategories) counts toward this goal. Refunds are taken off.', count: p.n, countedCents: p.neg - p.pos, inCents: p.pos, outCents: p.neg, rows: p.rows, openIn: g.category_id ? { categoryId: g.category_id } : null }
  }
  const items = (db.prepare('SELECT account_id AS accountId, debt_id AS debtId FROM goal_debt WHERE goal_id = ?').all(goalId) as { accountId: number | null; debtId: number | null }[]).map((x) => (x.accountId ? { accountId: x.accountId } : { debtId: x.debtId! }))
  const since = g.created_local // created_at is stored in UTC; transactions carry local dates, so compare local dates
  const p = page(db, payoffWhere(items, since), offset, limit)
  return { ...base, explain: `Payments made on these cards and loans since the goal started (${since}): money paid into a card, and payments counted toward a loan.`, count: p.n, countedCents: p.pos + p.neg, inCents: null, outCents: null, rows: p.rows, openIn: items.length === 1 && items[0]!.accountId ? { accountId: items[0]!.accountId, from: since } : null }
}

/** The payments behind one card or loan (a row of the debt payoff planner): everything paid on it, from the first transaction on record. */
export function payoffDetail(db: Db, item: DebtItem, label: string, offset = 0, limit = 50): GoalDetail {
  const p = page(db, payoffWhere([item], null), offset, limit)
  return { title: label, explain: item.accountId ? 'Money paid into this card (refunds are not counted).' : 'Payments counted toward this loan. Count a payment from the Review page or the loan’s Details.', count: p.n, countedCents: p.pos + p.neg, inCents: null, outCents: null, manualCents: 0, rows: p.rows, openIn: item.accountId ? { accountId: item.accountId } : null }
}
